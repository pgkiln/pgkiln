-- =====================================================================
-- HR sample, part 9: a document template (see docs/guide/16-files.md)
--
-- "Employee sheet": the employee's details and leave history as a PDF,
-- from the Print button on the employee form (page 3). The leave history
-- comes from a json_agg column, which the template repeats as table rows.
-- =====================================================================
insert into meta.document_template (app_id, name, description, query, template, filename)
select id, 'EMPLOYEE_SHEET', 'Employee sheet',
$q$select e.empno, initcap(e.ename) as name, initcap(e.job) as job, e.hiredate, e.sal, e.comm,
       d.dname as department, initcap(d.loc) as location, initcap(m.ename) as manager,
       (select count(*)::int from hr.leave_request l where l.empno = e.empno) as leave_count,
       (select json_agg(json_build_object('start', l.start_date, 'until', l.end_date, 'days', l.days,
                                          'status', initcap(l.status), 'reason', l.reason) order by l.start_date desc)
          from hr.leave_request l where l.empno = e.empno) as leave
  from hr.emp e
  left join hr.dept d on d.deptno = e.deptno
  left join hr.emp m on m.empno = e.mgr
 where e.empno = :P3_EMPNO::int$q$,
$t$<img src="logo" align="right" width="30mm">
<h1>{{name}}</h1>
<p class="muted">Employee {{empno}} · printed on {{TODAY|date}} by {{APP_USER}}</p>

<h2>Details</h2>
<table>
  <tr><th width="35%">Job</th><td>{{job}}</td></tr>
  <tr><th>Department</th><td>{{department|default:-}}{{#location}}, {{location}}{{/location}}</td></tr>
  <tr><th>Manager</th><td>{{manager|default:-}}</td></tr>
  <tr><th>Hired</th><td>{{hiredate|date}}</td></tr>
  <tr><th>Monthly salary</th><td>{{sal|number:2}}{{#comm}} plus {{comm|number:2}} commission{{/comm}}</td></tr>
</table>

<h2>Leave</h2>
{{#leave_count}}
<table>
  <thead><tr><th width="20%">From</th><th width="20%">Until</th><th width="10%" align="right">Days</th><th width="15%">Status</th><th>Reason</th></tr></thead>
  {{#leave}}<tr><td>{{start|date}}</td><td>{{until|date}}</td><td align="right">{{days}}</td><td>{{status}}</td><td>{{reason|default:-}}</td></tr>{{/leave}}
</table>
{{/leave_count}}
{{^leave_count}}<p class="muted">No leave requests.</p>{{/leave_count}}

<p>&nbsp;</p>
<table class="plain">
  <tr><td>Signed (employee): ____________________</td><td>Signed (manager): ____________________</td></tr>
</table>$t$,
'employee-&P3_EMPNO.'
  from meta.app where alias = 'hr';

insert into meta.button (page_id, region_id, seq, name, label, action, document, condition)
select p.id, r.id, 15, 'PRINT', 'Print', 'document', 'EMPLOYEE_SHEET', ':P3_EMPNO is not null'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 3;

-- Import employees (page 13) takes JSON files too since data loading reads them.
update meta.item i set config = config || '{"accept": ".csv,.tsv,.txt,.xlsx,.json"}', help = 'CSV, TSV, .xlsx or JSON, at most 5 MB.'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 13 and i.name = 'P13_FILE';
