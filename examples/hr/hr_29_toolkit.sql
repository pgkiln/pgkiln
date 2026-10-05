-- =====================================================================
-- HR example, part 29: declarative processes, branches and dialog events
-- (docs/guide/06-processing.md "Download", "Execution chains", "Workflow
-- processes", "Branches"; docs/guide/07-dynamic-actions.md "Dialog closed")
--
-- Page 28 "Employee toolkit", for a chosen employee:
--   * Business card: a download process sends a vCard made by a query;
--   * Documents: the employee's documents (hr.emp_document), one file as
--     it is, several as one zip file;
--   * Onboard: an execution chain that looks up the employee, then starts
--     the ONBOARDING workflow (a workflow process) with its variables;
--     Stop onboarding terminates it again (another workflow process);
--   * Year-end check: a chain that runs in the background; "My background
--     jobs" shows its state from meta.process_jobs;
--   * Open: a branch whose PL/pgSQL function returns where to go (the
--     leave requests when some are pending, else the leave calendar);
--   * Team: editing a colleague opens page 3 in a dialog; when it closes,
--     a "dialog closed" dynamic action refreshes the report instead of
--     reloading the page.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 28, 'Employee toolkit', 'Employee toolkit', 2 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Employee', 'static', 6, null, '{}'),
  (20, 'Team', 'report', 6,
   'select empno, initcap(ename) as ename, initcap(job) as job, sal
  from hr.emp
 where active and deptno = (select deptno from hr.emp where empno = :P28_EMPNO::int)
 order by ename',
   '{"link": {"page": 3, "items": {"P3_EMPNO": "#empno#"}, "column": "ename"}, "headings": {"empno": "No.", "ename": "Name", "sal": "Salary"}}'),
  (30, 'My background jobs', 'report', 12,
   'select id as job, name, state, steps_done || '' / '' || steps_total as steps, coalesce(error, message) as message,
       to_char(queued_at, ''YYYY-MM-DD HH24:MI:SS'') as queued
  from meta.process_jobs
 order by id desc
 limit 10', '{}')
  ) as r (seq, title, type, columns, source, config)
 where a.alias = 'hr' and p.page_no = 28;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, required, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.lov, false, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Employee', (values
  (10, 'P28_EMPNO', 'Employee', 'select', 'select initcap(ename) as d, empno as r from hr.emp where active order by ename', null),
  (20, 'P28_ENAME', 'Name', 'hidden', null, null),
  (30, 'P28_SAL', 'Salary', 'hidden', null, null),
  (40, 'P28_WORKFLOW_ID', 'Onboarding workflow', 'display', null, 'Set when Onboard starts the workflow.'),
  (50, 'P28_JOB_ID', 'Background job', 'display', null, 'Set when the year-end check is queued.')
  ) as i (seq, name, label, type, lov, help)
 where a.alias = 'hr' and p.page_no = 28;

-- yours, when none is chosen
insert into meta.computation (page_id, seq, item_name, point, type, expression, condition_type, condition_expr)
select p.id, 10, 'P28_EMPNO', 'before_header', 'sql_query', 'select empno from hr.emp where lower(username) = lower(:APP_USER)', 'item_null', 'P28_EMPNO'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 28;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, b.seq, b.name, b.label, 'submit', b.hot
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Employee', (values
  (10, 'CARD', 'Business card', true),
  (20, 'DOCUMENTS', 'Documents', false),
  (30, 'ONBOARD', 'Onboard', false),
  (40, 'STOP', 'Stop onboarding', false),
  (50, 'RECALC', 'Year-end check', false),
  (60, 'OPEN', 'Open', false)
  ) as b (seq, name, label, hot)
 where a.alias = 'hr' and p.page_no = 28;

-- processes: two downloads, a chain with a workflow process, a workflow process, a background chain
insert into meta.process (page_id, seq, name, type, code, config, when_button, parent_process,
                          condition_type, condition_expr, success_message)
select p.id, x.seq, x.name, x.type, x.code, x.config::jsonb, x.button, x.parent, x.ctype, x.cexpr, x.message
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Business card', 'download',
   $q$select convert_to(concat_ws(E'\r\n', 'BEGIN:VCARD', 'VERSION:3.0', 'FN:' || initcap(ename), 'TITLE:' || initcap(job),
                          'ORG:HR Demo;' || coalesce((select dname from hr.dept d where d.deptno = e.deptno), ''), 'END:VCARD'), 'UTF8') as content,
       lower(ename) || '.vcf' as filename, 'text/vcard' as mime_type
  from hr.emp e
 where empno = :P28_EMPNO::int$q$, '{}', 'CARD', null, 'item_not_null', 'P28_EMPNO', null),
  (20, 'Documents', 'download',
   'select content, filename, mime_type from hr.emp_document where empno = :P28_EMPNO::int order by uploaded_at, id',
   '{"zip_name": "documents-&P28_EMPNO..zip"}', 'DOCUMENTS', null, 'item_not_null', 'P28_EMPNO', null),
  (30, 'Onboard', 'chain', null, '{}', 'ONBOARD', null, 'item_not_null', 'P28_EMPNO', null),
  (31, 'Look up the employee', 'sql',
   'select initcap(ename) as p28_ename, sal as p28_sal from hr.emp where empno = :P28_EMPNO::int', '{}', null, 'Onboard', null, null, null),
  (32, 'Start the workflow', 'workflow', null,
   '{"action": "start", "definition": "ONBOARDING", "detail_pk": "&P28_EMPNO.", "variables": {"ENAME": "&P28_ENAME.", "SAL": "&P28_SAL."}, "id_item": "P28_WORKFLOW_ID"}',
   null, 'Onboard', null, null, null),
  (40, 'Stop onboarding', 'workflow', null,
   '{"action": "terminate", "instance": "&P28_WORKFLOW_ID.", "comment": "Stopped from the employee toolkit."}', 'STOP', null,
   'item_not_null', 'P28_WORKFLOW_ID', null),
  (50, 'Year-end check', 'chain', null, '{"background": true, "status_item": "P28_JOB_ID"}', 'RECALC', null, null, null, null),
  (51, 'Check salaries', 'sql',
   $q$do $b$ begin if exists (select 1 from hr.emp where active and sal is null) then raise notice 'salaries missing'; end if; end $b$$q$,
   '{}', null, 'Year-end check', null, null, 'Salaries checked.'),
  (52, 'Check the department', 'sql',
   'select count(*) as staff from hr.emp where deptno = (select deptno from hr.emp where empno = :P28_EMPNO::int)',
   '{}', null, 'Year-end check', 'item_not_null', 'P28_EMPNO', 'Department checked.')
  ) as x (seq, name, type, code, config, button, parent, ctype, cexpr, message)
 where a.alias = 'hr' and p.page_no = 28;

-- Open: a PL/pgSQL function decides where to go
insert into meta.branch (page_id, seq, name, when_button, target_type, target_function)
select p.id, 10, 'Open the right page', 'OPEN', 'function',
       E'begin\n  if exists (select 1 from hr.leave_request where empno = :P28_EMPNO::int and status = ''PENDING'') then\n    return ''6'';\n  end if;\n  return ''12'';\nend'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 28;

-- the employee dialog (page 3) closes: refresh the team instead of reloading the page
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id)
select p.id, 10, 'Refresh the team', 'dialog_closed', '3', 'refresh_region', r.id
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Team'
 where a.alias = 'hr' and p.page_no = 28;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 80, 'Employee toolkit', 'download', 28
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Employees' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Employee toolkit', 'Medewerkersgereedschap'),
  ('My background jobs', 'Mijn achtergrondtaken'),
  ('Business card', 'Visitekaartje'),
  ('Documents', 'Documenten'),
  ('Onboard', 'Inwerken'),
  ('Stop onboarding', 'Inwerken stoppen'),
  ('Year-end check', 'Jaareindcontrole'),
  ('Open', 'Openen'),
  ('Onboarding workflow', 'Inwerkworkflow'),
  ('Background job', 'Achtergrondtaak'),
  ('Salaries checked.', 'Salarissen gecontroleerd.'),
  ('Department checked.', 'Afdeling gecontroleerd.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
