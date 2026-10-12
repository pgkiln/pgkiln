-- =====================================================================
-- HR example, part 53: data and settings (migration 086;
-- docs/guide/06-processing.md "Application settings", "User preferences",
-- "Data export"; docs/guide/14-globalization.md "Dynamic translations";
-- docs/guide/05-items.md "Display image", "Geocoded address")
--
-- Application settings SUPPORT_EMAIL and LEAVE_APPROVAL (Shared
-- Components → Application settings), read with meta.get_app_setting.
-- Dynamic translations of the department names in Dutch and German:
-- meta.lang(dname). Page 43 "Data and settings" (Administration):
--   - P43_DEPTNO, a department (names through meta.lang), kept per user
--     across sessions ({"persist": "user"});
--   - P43_EMPNO, an employee of that department, also kept per user, and
--     P43_PHOTO, the employee's photo from hr.emp.photo (display image);
--   - P43_ADDRESS, a geocoded address whose position goes into P43_LOCATION
--     (the "Check address" button shows where the server has GEOCODER_URL);
--   - Excel and CSV downloads of the department's employees (the download
--     process with {"export": …}, APEX_DATA_EXPORT).
-- =====================================================================

insert into meta.app_setting (app_id, name, value, description, required, valid_values)
select a.id, s.name, s.value, s.description, s.required, s.valid_values
  from meta.app a, (values
  ('SUPPORT_EMAIL', 'hr-support@example.com', 'Where users write with questions; shown on page 43.', true, null::text[]),
  ('LEAVE_APPROVAL', 'manager', 'Who approves leave requests: the manager, or the HR department.', true, '{manager,hr}'::text[])
  ) as s (name, value, description, required, valid_values)
 where a.alias = 'hr';

insert into meta.dynamic_translation (app_id, language, source, target)
select a.id, t.language, t.source, t.target
  from meta.app a, (values
  ('nl', 'ACCOUNTING', 'BOEKHOUDING'), ('nl', 'RESEARCH', 'ONDERZOEK'), ('nl', 'SALES', 'VERKOOP'), ('nl', 'OPERATIONS', 'BEDRIJFSVOERING'),
  ('de', 'ACCOUNTING', 'BUCHHALTUNG'), ('de', 'RESEARCH', 'FORSCHUNG'), ('de', 'SALES', 'VERTRIEB'), ('de', 'OPERATIONS', 'BETRIEB')
  ) as t (language, source, target)
 where a.alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 43, 'Data and settings', 'Data and settings', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template)
select p.id, r.seq, r.title, 'static', 12, 'standard'
  from meta.page p join meta.app a on a.id = p.app_id, (values (10, 'Employee'), (20, 'Visit address')) as r (seq, title)
 where a.alias = 'hr' and p.page_no = 43;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, help, config)
select p.id, (select r.id from meta.region r where r.page_id = p.id and r.title = i.region), i.seq, i.name, i.label, i.type, i.lov, i.help, i.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('Employee', 10, 'P43_DEPTNO', 'Department', 'select',
   'select meta.lang(dname), deptno from hr.dept order by 1', 'Remembered for you, also after you sign out.',
   '{"persist": "user", "submit_on_change": true, "null_label": "- All -"}'),
  ('Employee', 20, 'P43_EMPNO', 'Employee', 'select',
   'select initcap(ename), empno from hr.emp where :P43_DEPTNO is null or deptno = :P43_DEPTNO::int order by 1', null,
   '{"persist": "user", "submit_on_change": true, "null_label": "- Choose -"}'),
  ('Employee', 30, 'P43_PHOTO', 'Photo', 'image', null, null,
   '{"sql": "select photo, photo_mime from hr.emp where empno = :P43_EMPNO::int", "alt": "Photo of the employee", "width": 160}'),
  ('Employee', 40, 'P43_SUPPORT', 'Questions?', 'display', null, 'The application setting SUPPORT_EMAIL.', '{}'),
  ('Visit address', 50, 'P43_ADDRESS', 'Address', 'address', null, 'Type the address and choose it from the list.',
   '{"coordinates_item": "P43_LOCATION"}'),
  ('Visit address', 60, 'P43_LOCATION', 'Position', 'location', null, null, '{}')
  ) as i (region, seq, name, label, type, lov, help, config)
 where a.alias = 'hr' and p.page_no = 43;

insert into meta.button (page_id, region_id, seq, name, label, action)
select p.id, (select r.id from meta.region r where r.page_id = p.id and r.title = 'Employee'), b.seq, b.name, b.label, 'submit'
  from meta.page p join meta.app a on a.id = p.app_id, (values (10, 'EXPORT_XLSX', 'Download Excel'), (20, 'EXPORT_CSV', 'Download CSV')) as b (seq, name, label)
 where a.alias = 'hr' and p.page_no = 43;

insert into meta.process (page_id, seq, name, type, point, code, when_button, config)
select p.id, x.seq, x.name, x.type, x.point, x.code, x.button, x.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Support address', 'sql', 'load', 'select meta.get_app_setting(''SUPPORT_EMAIL'') as p43_support', null, '{}'),
  (20, 'Employees as Excel', 'download', 'submit',
   'select e.empno, initcap(e.ename) as name, initcap(e.job) as job, e.hiredate, e.sal as salary, meta.lang(d.dname) as department
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 where :P43_DEPTNO is null or e.deptno = :P43_DEPTNO::int
 order by e.ename', 'EXPORT_XLSX', '{"export": "xlsx", "file_name": "employees", "title": "Employees"}'),
  (30, 'Employees as CSV', 'download', 'submit',
   'select e.empno, initcap(e.ename) as name, initcap(e.job) as job, e.hiredate, e.sal as salary, meta.lang(d.dname) as department
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 where :P43_DEPTNO is null or e.deptno = :P43_DEPTNO::int
 order by e.ename', 'EXPORT_CSV', '{"export": "csv", "file_name": "employees"}')
  ) as x (seq, name, type, point, code, button, config)
 where a.alias = 'hr' and p.page_no = 43;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 40, 'Data and settings', 'settings', 43
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Data and settings', 'Gegevens en instellingen'),
  ('Employee', 'Medewerker'),
  ('Visit address', 'Bezoekadres'),
  ('Department', 'Afdeling'),
  ('Photo', 'Foto'),
  ('Questions?', 'Vragen?'),
  ('Address', 'Adres'),
  ('Position', 'Positie'),
  ('Download Excel', 'Excel downloaden'),
  ('Download CSV', 'CSV downloaden'),
  ('Remembered for you, also after you sign out.', 'Wordt voor u onthouden, ook na afmelden.'),
  ('The application setting SUPPORT_EMAIL.', 'De applicatie-instelling SUPPORT_EMAIL.'),
  ('Type the address and choose it from the list.', 'Typ het adres en kies het uit de lijst.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
