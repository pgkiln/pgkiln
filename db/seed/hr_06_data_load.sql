-- =====================================================================
-- HR sample, part 6: data loading (see docs/guide/16-files.md)
--
-- Page 13: import employees (ADMIN) — a data_load process merges a CSV or
-- Excel file into hr.emp by empno. It runs as hr_app, so the salary
-- trigger, foreign keys and the audit trail apply; with an error in any
-- row nothing is loaded and the rows with errors are listed.
-- =====================================================================
insert into meta.page (app_id, page_no, name, title, parent_page, authz)
select id, 13, 'Import employees', 'Import employees', 2, 'ADMIN' from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, source)
select p.id, 10, 'Upload a file', 'static',
       E'<p>Upload a CSV or Excel (.xlsx) file with a heading row. Columns are matched by name: '
       '<code>empno, ename, job, mgr, hiredate, sal, comm, deptno</code>. Rows with an existing '
       '<code>empno</code> are updated, the others are added.</p>'
       '<p><a href="/static/samples/employees.csv" download>Download an example file</a></p>'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 13;

insert into meta.item (page_id, region_id, seq, name, label, type, required, help, config)
select p.id, r.id, 10, 'P13_FILE', 'File', 'file', true, 'CSV, TSV or .xlsx, at most 5 MB.',
       '{"accept": ".csv,.tsv,.txt,.xlsx", "max_mb": 5, "wide": true}'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id
 where a.alias = 'hr' and p.page_no = 13;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 10, 'LOAD', 'Load', 'submit', true
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id
 where a.alias = 'hr' and p.page_no = 13;

insert into meta.process (page_id, seq, name, type, when_button, config)
select p.id, 10, 'Load employees', 'data_load', 'LOAD',
       '{"file_item": "P13_FILE", "table": "hr.emp", "mode": "merge"}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 13;

with a as (select id from meta.app where alias = 'hr'),
admin as (select n.id, n.app_id from meta.nav_entry n, a where n.app_id = a.id and n.label = 'Administration' and n.parent_id is null)
insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page, authz)
select admin.app_id, admin.id, 30, 'Import employees', 'upload', 13, 'ADMIN' from admin;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Import employees', 'Medewerkers importeren'),
  ('Upload a file', 'Bestand uploaden'),
  ('File', 'Bestand'),
  ('Load', 'Laden'),
  ('CSV, TSV or .xlsx, at most 5 MB.', 'CSV, TSV of .xlsx, maximaal 5 MB.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
