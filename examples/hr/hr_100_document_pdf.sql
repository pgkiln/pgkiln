-- =====================================================================
-- HR example, part 100: a document template's PDF as a mail attachment
-- (sprint 237, MG-3; migration 192; docs/guide/06-processing.md "Send
-- e-mail" and "Sending e-mail")
--
-- The employee form (page 3) has, next to Print (the EMPLOYEE_SHEET
-- template of part 9 as a download), a button "Mail sheet": a process
-- queues a mail to the employee with the same sheet attached as PDF,
-- drawn on the server from SQL:
--   meta.document_pdf('EMPLOYEE_SHEET', jsonb_build_object('P3_EMPNO', …))
-- gives a reference to the PDF that meta.add_mail_attachment takes; the
-- server draws it when the process ends, in the same transaction, as
-- HR's role, and puts it in the mail before the submit commits.
-- (APEX: APEX_PRINT.GENERATE_DOCUMENT and APEX_MAIL.ADD_ATTACHMENT; no
-- jsPDF in the browser and no hidden file item.)
-- The process runs only when HR has a mail service (part 51: "log
-- only", nothing leaves the server) and the employee a user account with
-- an e-mail address (hr.employee_email of part 67).
-- =====================================================================

insert into meta.button (page_id, region_id, seq, name, label, action, condition_type, condition)
select p.id, r.id, 17, 'MAIL_SHEET', 'Mail sheet', 'submit', 'item_not_null', 'P3_EMPNO'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 3
   and not exists (select 1 from meta.button x where x.page_id = p.id and x.name = 'MAIL_SHEET');

insert into meta.process (page_id, seq, name, type, point, when_button, code, success_message, condition_type, condition_expr)
select p.id, 25, 'Mail the employee sheet', 'sql', 'submit', 'MAIL_SHEET',
$s$select meta.add_mail_attachment(m.id,
         meta.document_pdf('EMPLOYEE_SHEET', jsonb_build_object('P3_EMPNO', :P3_EMPNO)),
         'employee-' || :P3_EMPNO || '.pdf', 'application/pdf')
  from (select meta.send_mail(hr.employee_email(:P3_EMPNO::int), 'Your employee sheet',
                              'Attached is your employee sheet as HR has it today.') as id) m$s$,
       'The employee sheet is on its way to &P3_ENAME..',
       'sql', 'meta.mail_available() and hr.employee_email(:P3_EMPNO::int) is not null'
  from meta.page p
  join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 3
   and not exists (select 1 from meta.process x where x.page_id = p.id and x.name = 'Mail the employee sheet');
