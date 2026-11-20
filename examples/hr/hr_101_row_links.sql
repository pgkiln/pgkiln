-- =====================================================================
-- HR example, part 101: link columns and inline dialogs by static id
-- (migration 194, sprint 238, MG-6 and MG-14; docs/guide/04-pages-and-regions.md
-- "Link columns and row actions" and "Region templates")
--
-- Page 66 "Row links" (Administration):
--   - an interactive report of the departments with link columns in each
--     style: an icon (Edit, before the columns; page 5 is modal, so it
--     opens as a dialog), a button shown only in rows with staff (when),
--     a primary button, a danger button and a plain link; and a row
--     actions menu (Edit, Employees of …);
--   - a classic report (table) with a link column, and one with the
--     media list template whose links sit under each department;
--   - an inline dialog "Department note" (static id dept-note) opened by
--     a button (target_region) and by a link to #dept-note in static
--     content. Its note is required: a submit without one shows the page
--     again with the dialog open. "Save and add another" runs a process
--     with open_region dept-note: the page comes back with the dialog
--     open and empty. "Save" takes a branch with open_region note-kept,
--     a second inline dialog that shows the note.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 66, 'Row links', 'Row links', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, static_id, config)
select p.id, r.seq, r.title, r.type, r.columns, r.template, r.source, r.static_id, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Departments', 'report', 12, 'standard',
   'select d.deptno, d.dname, d.loc, (select count(*) from hr.emp e where e.deptno = d.deptno) as staff,
       exists (select 1 from hr.emp e where e.deptno = d.deptno) as has_staff
  from hr.dept d
 order by d.deptno', 'departments',
   '{"hidden": ["has_staff"], "headings": {"deptno": "No.", "dname": "Department", "loc": "Location", "staff": "Staff"},
     "link_columns": [
       {"label": "Edit #dname#", "heading": "Edit", "page": 5, "items": {"P5_DEPTNO": "#deptno#"}, "style": "icon", "icon": "edit", "position": "start"},
       {"label": "Employees", "page": 2, "items": {"P2_DEPTNO": "#deptno#"}, "style": "button", "icon": "users", "when": "has_staff"},
       {"label": "Overview", "page": 53, "items": {"P53_DEPTNO": "#deptno#"}, "style": "hot"},
       {"label": "Delete…", "heading": "Delete", "page": 5, "items": {"P5_DEPTNO": "#deptno#"}, "style": "danger"},
       {"label": "Directory", "page": 11, "style": "link"}],
     "row_actions": {"edit": {"page": 5, "items": {"P5_DEPTNO": "#deptno#"}},
                     "links": [{"label": "Employees of #dname#", "page": 2, "items": {"P2_DEPTNO": "#deptno#"}}]}}'),
  (20, 'Locations', 'classic_report', 6, 'standard',
   'select loc, count(*) as departments, min(deptno) as first_deptno from hr.dept group by loc order by loc', 'locations',
   '{"hidden": ["first_deptno"], "headings": {"loc": "Location", "departments": "Departments"},
     "link_columns": [{"label": "First department", "page": 53, "items": {"P53_DEPTNO": "#first_deptno#"}}]}'),
  (30, 'Department cards', 'classic_report', 6, 'standard',
   'select dname as title, ''In '' || initcap(loc) as description, deptno from hr.dept order by dname', 'department-cards',
   '{"report_template": "media_list", "hidden": ["deptno"],
     "link_columns": [{"label": "Edit", "page": 5, "items": {"P5_DEPTNO": "#deptno#"}, "style": "button", "icon": "edit"},
                      {"label": "Overview", "page": 53, "items": {"P53_DEPTNO": "#deptno#"}}]}'),
  (40, 'Notes', 'static', 12, 'standard',
   '<p>Write a note about a department: use the button, or <a href="#dept-note">this link to #dept-note</a>.</p>', 'notes', '{}'),
  (50, 'Department note', 'static', 12, 'inline_dialog',
   '<p>A note is required: saving without one shows this dialog again with the error.</p>', 'dept-note', '{}'),
  (60, 'Note kept', 'static', 12, 'inline_dialog',
   '<p>The branch after Save opened this dialog (open_region note-kept).</p><p><strong>&P66_LAST_NOTE.</strong></p>', 'note-kept', '{}')
  ) as r (seq, title, type, columns, template, source, static_id, config)
 where a.alias = 'hr' and p.page_no = 66;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, required, config)
select p.id, (select x.id from meta.region x where x.page_id = p.id and x.static_id = i.region), i.seq, i.name, i.label, i.type, i.lov, i.required, '{}'::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('dept-note', 10, 'P66_DEPTNO', 'Department', 'select', 'select meta.lang(dname), deptno from hr.dept order by 1', false),
  ('dept-note', 20, 'P66_NOTE', 'Note', 'textarea', null, true),
  ('notes', 30, 'P66_LAST_NOTE', null, 'hidden', null, false)
  ) as i (region, seq, name, label, type, lov, required)
 where a.alias = 'hr' and p.page_no = 66;

insert into meta.button (page_id, region_id, seq, name, label, action, hot, target_region)
select p.id, (select x.id from meta.region x where x.page_id = p.id and x.static_id = b.region), b.seq, b.name, b.label, b.action, b.hot, b.target_region
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('notes', 10, 'ADD_NOTE', 'Add a note', 'redirect', false, 'dept-note'),
  ('dept-note', 20, 'SAVE_ANOTHER', 'Save and add another', 'submit', false, null),
  ('dept-note', 30, 'SAVE_NOTE', 'Save', 'submit', true, null)
  ) as b (region, seq, name, label, action, hot, target_region)
 where a.alias = 'hr' and p.page_no = 66;

-- the note is kept in session state only (a sample: no table)
insert into meta.process (page_id, seq, name, type, code, point, when_button, success_message, config, open_region)
select p.id, x.seq, x.name, x.type, x.code, 'submit', x.when_button, x.message, x.config::jsonb, x.open_region
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Keep the note', 'sql', 'select :P66_NOTE as p66_last_note', null, 'Note kept.', '{}', null),
  (20, 'Ready for another', 'clear_session_state', null, 'SAVE_ANOTHER', null, '{"items": ["P66_NOTE"]}', 'dept-note')
  ) as x (seq, name, type, code, when_button, message, config, open_region)
 where a.alias = 'hr' and p.page_no = 66;

insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_page, open_region)
select p.id, 10, 'Show the note', 'after_processing', 'SAVE_NOTE', 'page', 66, 'note-kept'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 66;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 66, 'Row links', 'link', 66
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Row links', 'Rijkoppelingen'),
  ('Employees', 'Medewerkers'),
  ('Overview', 'Overzicht'),
  ('Department note', 'Notitie bij afdeling'),
  ('Note kept', 'Notitie bewaard')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
