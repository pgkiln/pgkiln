-- =====================================================================
-- HR example, part 109: a document template's PDF kept in a table
-- (sprint 245, MG-18 and MG-26; migration 202; docs/guide/16-files.md
-- "Document templates")
--
-- The employee form (page 3) has a button "Keep a copy": it stores the
-- employee record as it is today, as a PDF, among the employee's
-- Documents (hr.emp_document, part 16). Two processes:
--   1. meta.document_temp_file('EMPLOYEE_RECORD', items, file name)
--      returns the id of a temporary file of the session into the
--      hidden item P3_RECORD_FILE; the server draws the PDF into it when
--      the process ends (same transaction, as HR's role);
--   2. the next process reads the PDF from meta.temp_files like an
--      upload and inserts it into hr.emp_document.
-- (APEX: APEX_PRINT.GENERATE_DOCUMENT into a BLOB.)
--
-- The EMPLOYEE_RECORD template (report layout HR_LETTERHEAD, with a
-- logo) shows the renderer's inline content:
-- the layout's logo beside the title in a table cell (<img> in a <td>,
-- width in mm), a heading in a cell, <br> line breaks in cells and
-- paragraphs, and two signature boxes side by side.
-- Only managers of the employee and administrators may keep a copy
-- (hr.emp_document's insert policy says the same).
-- =====================================================================

-- a report layout with a logo (a small PNG) for the record
insert into meta.report_layout (app_id, name, logo, logo_mime, logo_width_mm)
select a.id, 'HR_LETTERHEAD',
       decode('iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAIAAAC6iKlyAAAAjklEQVR42u3asQ2AIBAFUDZxEWZyEms3sHE6NtDKxsQCIhdI3s9f4B5XXEG6JCQJQSj0ktfIggYNGjRo0KBBgwYN+mk586tV0MGPHbxDoEGDBg0aNOiGIb9AQc8B7Y4GDRo0aNDjQdeCgp4DetuPAQsaNGjQoEG7OkCDBg3adwPQoEGDBg0aNGjQf0JL79yVz0gRiXKhJQAAAABJRU5ErkJggg==', 'base64'),
       'image/png', 32
  from meta.app a
 where a.alias = 'hr'
   and not exists (select 1 from meta.report_layout x where x.app_id = a.id and x.name = 'HR_LETTERHEAD');

insert into meta.document_template (app_id, name, description, query, template, filename, layout)
select id, 'EMPLOYEE_RECORD', 'Employee record',
$q$select e.empno, initcap(e.ename) as name, initcap(e.job) as job, e.hiredate, e.sal,
       d.dname as department, initcap(d.loc) as location, initcap(m.ename) as manager,
       (select count(*)::int from hr.emp_document x where x.empno = e.empno) as kept
  from hr.emp e
  left join hr.dept d on d.deptno = e.deptno
  left join hr.emp m on m.empno = e.mgr
 where e.empno = :P3_EMPNO::int$q$,
$t$<table class="plain">
  <tr>
    <td width="36mm"><img src="logo" width="32mm"></td>
    <td><h2>Employee record</h2>{{name}} · {{job}}<br><span class="muted">Employee {{empno}}</span></td>
    <td width="45mm" align="right"><small class="muted">Kept on {{TODAY|date}}<br>by {{APP_USER}}</small></td>
  </tr>
</table>
<hr>
<table>
  <tr><th width="35%">Department</th><td>{{department|default:-}}<br><span class="muted">{{location|default:-}}</span></td></tr>
  <tr><th>Manager</th><td>{{manager|default:-}}</td></tr>
  <tr><th>Hired</th><td>{{hiredate|date}}</td></tr>
  <tr><th>Monthly salary</th><td>{{sal|number:2}}</td></tr>
</table>
<p>This record was kept among the employee's documents.<br>Earlier copies: {{kept}}.</p>
<p>&nbsp;</p>
<table class="plain">
  <tr>
    <td>Employee<br><br>______________________<br>{{name}}</td>
    <td>Manager<br><br>______________________<br>{{manager|default:-}}</td>
  </tr>
</table>$t$,
'record-&P3_EMPNO.', 'HR_LETTERHEAD'
  from meta.app a
 where a.alias = 'hr'
   and not exists (select 1 from meta.document_template x where x.app_id = a.id and x.name = 'EMPLOYEE_RECORD');

insert into meta.item (page_id, region_id, seq, name, label, type)
select p.id, r.id, 130, 'P3_RECORD_FILE', null, 'hidden'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 3
   and not exists (select 1 from meta.item x where x.page_id = p.id and x.name = 'P3_RECORD_FILE');

insert into meta.button (page_id, region_id, seq, name, label, action, condition)
select p.id, r.id, 18, 'KEEP_RECORD', 'Keep a copy', 'submit',
       ':P3_EMPNO is not null and (hr.is_manager_of(:P3_EMPNO::int) or meta.has_role(''admin''))'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 3
   and not exists (select 1 from meta.button x where x.page_id = p.id and x.name = 'KEEP_RECORD');

-- 1. the id of the temporary file (a column named like the item sets it); drawn when this process ends
insert into meta.process (page_id, seq, name, type, point, when_button, code)
select p.id, 26, 'Draw the employee record', 'sql', 'submit', 'KEEP_RECORD',
$s$select meta.document_temp_file('EMPLOYEE_RECORD', jsonb_build_object('P3_EMPNO', :P3_EMPNO),
                                  'record-' || :P3_EMPNO || '-' || to_char(now(), 'YYYYMMDD-HH24MI')) as p3_record_file$s$
  from meta.page p
  join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 3
   and not exists (select 1 from meta.process x where x.page_id = p.id and x.name = 'Draw the employee record');

-- 2. the PDF, read like an upload
insert into meta.process (page_id, seq, name, type, point, when_button, code, success_message)
select p.id, 27, 'Keep the employee record', 'sql', 'submit', 'KEEP_RECORD',
$s$insert into hr.emp_document (empno, filename, mime_type, content)
select :P3_EMPNO::int, t.filename, t.mime_type, t.content from meta.temp_files t where t.id = :P3_RECORD_FILE::uuid$s$,
       'A copy of the employee record of &P3_ENAME. is kept among the documents.'
  from meta.page p
  join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 3
   and not exists (select 1 from meta.process x where x.page_id = p.id and x.name = 'Keep the employee record');

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Keep a copy', 'Kopie bewaren'),
  ('A copy of the employee record of &P3_ENAME. is kept among the documents.', 'Een kopie van de personeelskaart van &P3_ENAME. is bij de documenten bewaard.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
