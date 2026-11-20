-- =====================================================================
-- HR example, part 103: a dialog that stays open, items in a grid's
-- toolbar, web requests made right after Ajax callbacks (sprint 240,
-- MG-7 and MG-8; migration 196; docs/guide/04-pages.md "Modal dialog
-- pages", 05-regions-and-items "Interactive grid", 09-reference.md "Web
-- requests from SQL").
--
-- Page 35 "Parse and fetch" gets a button "Import contacts" that opens
-- page 67, a modal dialog: upload → preview → import in one dialog.
--   - The grid "Contacts to import" (hr.contact_import, your own rows)
--     has the file item P67_FILE in its toolbar, next to its search.
--   - "Read the file" (stay_in_dialog) parses the CSV into the grid and
--     shows the dialog again with "n lines read: check them below"; edit
--     the rows and press the grid's Save, which stays in the dialog too.
--   - "Start over" empties the grid; its branch (stay_in_dialog) goes
--     back to page 67 inside the dialog.
--   - "Import" copies the rows into the sample CRM (hr.crm_contact) and
--     closes the dialog, as every other submit of a dialog does.
--   - "Look up" calls the Ajax callback LOOKUP_CONTACT, a chain of two
--     SQL processes: the first queues meta.web_request() to the CRM's
--     REST handler, the server makes it right after that step, and the
--     second reads meta.web_response() and answers with the contact.
--     No polling: the answer of the one call has the result.
--   - "Count the CRM's contacts": an execute_sql action queues a request
--     (made right after it), the next set_value action reads the answer.
--   The web requests need the host allowed, as for page 35:
--       PGKILN_REST_ALLOWED_HOSTS=127.0.0.1
--       PGKILN_REST_PRIVATE_HOSTS=127.0.0.1
-- =====================================================================

create table hr.contact_import (
  id        serial primary key,
  name      text not null,
  company   text,
  email     text,
  added_by  text not null default current_setting('pgkiln.app_user', true)
);
grant select, insert, update, delete on hr.contact_import to hr_app;
grant usage on sequence hr.contact_import_id_seq to hr_app;

insert into meta.page (app_id, page_no, name, title, parent_page, mode)
select id, 67, 'Import contacts', 'Import contacts', 35, 'modal' from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, table_name, pk_column, config, static_id)
select p.id, r.seq, r.title, r.type, 12, r.template, r.source, r.tbl, r.pk, r.config::jsonb, r.sid
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'About this dialog', 'static', 'plain',
   '<p>Choose a CSV file with the columns name, company and e-mail (in the grid''s toolbar) and press <b>Read the file</b>: the dialog stays open and the grid shows the lines. Correct them and press <b>Save</b>, then <b>Import</b> to add them to the CRM, which closes the dialog.</p>',
   null, null, '{}', 'import-about'),
  (20, 'Contacts to import', 'grid', 'standard',
   'select id, name, company, email from hr.contact_import where added_by = :APP_USER',
   'hr.contact_import', 'id',
   '{"page_size": 10, "headings": {"id": "No.", "name": "Name", "company": "Company", "email": "E-mail"}, "columns": {"name": {"required": true}}, "readonly": ["id"], "views": [], "empty": "Nothing to import yet: read a file."}',
   'import-grid'),
  (30, 'Look up a CRM contact', 'static', 'standard',
   '<p><b>Look up</b> asks the CRM''s web service for one contact in a single Ajax call; <b>Count the CRM''s contacts</b> asks for all of them with two dynamic actions.</p>',
   null, null, '{}', 'import-lookup')
  ) as r (seq, title, type, template, source, tbl, pk, config, sid)
 where a.alias = 'hr' and p.page_no = 67;

insert into meta.item (page_id, region_id, seq, name, label, type, config, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.config::jsonb, i.help
  from (values
  -- in the grid's toolbar (sprint 240)
  (10, 'Contacts to import', 'P67_FILE', 'CSV file', 'file', '{"accept": ".csv,text/csv", "max_mb": 1}', 'Columns: name, company, e-mail (a heading line first).'),
  (10, 'Look up a CRM contact', 'P67_CRM_ID', 'Contact number', 'number', '{}', 'The number of a contact in the sample CRM, e.g. 2.'),
  (20, 'Look up a CRM contact', 'P67_CRM_FOUND', 'Found', 'display', '{}', null),
  (30, 'Look up a CRM contact', 'P67_CRM_COUNT', 'In the CRM', 'display', '{}', null),
  (40, 'Look up a CRM contact', 'P67_CRM_REQUEST', 'Request', 'hidden', '{}', null),
  (50, 'Look up a CRM contact', 'P67_COUNT_REQUEST', 'Count request', 'hidden', '{}', null)
  ) as i (seq, region, name, label, type, config, help)
  join meta.page p on p.page_no = 67 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = i.region;

insert into meta.button (page_id, region_id, seq, name, label, action, hot, stay_in_dialog, confirm)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.hot, b.stay, b.confirm
  from (values
  (10, 'Contacts to import', 'PREVIEW', 'Read the file', 'submit', false, true, null),
  (20, 'Contacts to import', 'CLEAR', 'Start over', 'submit', false, null, 'Remove the lines read so far?'),
  (30, 'Contacts to import', 'IMPORT', 'Import', 'submit', true, null, null),
  (10, 'Look up a CRM contact', 'LOOKUP', 'Look up', 'da', false, null, null),
  (20, 'Look up a CRM contact', 'COUNT', 'Count the CRM''s contacts', 'da', false, null, null)
  ) as b (seq, region, name, label, action, hot, stay, confirm)
  join meta.page p on p.page_no = 67 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = b.region;

insert into meta.validation (page_id, seq, name, item_name, type, message, when_button)
select p.id, 10, 'A file to read', 'P67_FILE', 'not_null', 'Choose a CSV file first.', 'PREVIEW'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 67;

insert into meta.process (page_id, seq, name, type, point, code, when_button, success_message, region_id, parent_process)
select p.id, x.seq, x.name, x.type, x.point, x.code, x.btn, x.msg,
       case when x.type = 'grid_dml' then (select r.id from meta.region r where r.page_id = p.id and r.title = 'Contacts to import') end,
       x.parent
  from (values
  (10, 'Read the file', 'sql', 'submit',
   $c$delete from hr.contact_import where added_by = :APP_USER;
insert into hr.contact_import (name, company, email)
select left(trim(d.cols[1]), 200), left(trim(d.cols[2]), 200), left(trim(d.cols[3]), 200)
  from meta.temp_files f, meta.parse_data(f.content, f.filename) d
 where f.id = :P67_FILE::uuid and coalesce(trim(d.cols[1]), '') <> '';
select meta.delete_temp_file(:P67_FILE::uuid);$c$,
   'PREVIEW', 'The file is read: check the lines below, then Import.', null),
  (20, 'Save the lines', 'grid_dml', 'submit', null, null, null, null),
  (30, 'Start over', 'sql', 'submit',
   'delete from hr.contact_import where added_by = :APP_USER', 'CLEAR', 'The lines are removed.', null),
  (40, 'Import into the CRM', 'sql', 'submit',
   $c$insert into hr.crm_contact (name, company, email)
select name, company, email from hr.contact_import where added_by = :APP_USER order by id;
delete from hr.contact_import where added_by = :APP_USER;$c$,
   'IMPORT', 'The contacts are imported into the CRM.', null),
  -- an Ajax callback that is a chain: the request queued by the first step is made before the second runs
  (50, 'LOOKUP_CONTACT', 'chain', 'ajax', null, null, null, null),
  (60, 'Ask the CRM', 'sql', 'ajax',
   $c$select meta.web_request(current_setting('pgkiln.public_url') || '/a/hr/rest/crm/contacts/' || (:P67_CRM_ID)::int,
                        p_timeout_s => 5) as p67_crm_request$c$, null, null, 'LOOKUP_CONTACT'),
  (70, 'Read the answer', 'sql', 'ajax',
   $c$select case when r ->> 'status' <> 'ok' then 'The CRM did not answer: ' || coalesce(r ->> 'message', r ->> 'status')
            when (r ->> 'status_code')::int <> 200 then 'No contact ' || :P67_CRM_ID || ' in the CRM (HTTP ' || (r ->> 'status_code') || ').'
            else concat_ws(', ', r -> 'json' ->> 'name', r -> 'json' ->> 'company', r -> 'json' ->> 'email') end as p67_crm_found,
       (r ->> 'status_code')::int = 200 as found
  from meta.web_response(:P67_CRM_REQUEST::bigint) r$c$, null, null, 'LOOKUP_CONTACT')
  ) as x (seq, name, type, point, code, btn, msg, parent)
  join meta.page p on p.page_no = 67 join meta.app a on a.id = p.app_id and a.alias = 'hr';

-- "Start over" comes back to this page inside the dialog (without the branch, a submit closes it)
insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_page, stay_in_dialog)
select p.id, 10, 'Start over in the dialog', 'after_processing', 'CLEAR', 'page', 67, true
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 67;

-- Look up: the Ajax callback, from hr-import.js; Count: execute_sql, then set_value reads the response
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items, code)
select p.id, d.seq, d.name, 'click', d.btn, d.action, d.items, d.code
  from (values
  (10, 'Look up the contact', 'LOOKUP', 'execute_javascript', null, 'hr.lookupContact'),
  (20, 'Ask the CRM for its contacts', 'COUNT', 'execute_sql', 'P67_COUNT_REQUEST',
   $c$select meta.web_request(current_setting('pgkiln.public_url') || '/a/hr/rest/crm/contacts', p_timeout_s => 5) as p67_count_request$c$),
  (30, 'Count them', 'COUNT', 'set_value', 'P67_CRM_COUNT',
   $c$select case when r ->> 'status' = 'ok' then jsonb_array_length(coalesce(r -> 'json' -> 'items', '[]')) || ' contacts'
            else 'The CRM did not answer: ' || coalesce(r ->> 'message', r ->> 'status') end
  from meta.web_response(:P67_COUNT_REQUEST::bigint) r$c$)
  ) as d (seq, name, btn, action, items, code)
  join meta.page p on p.page_no = 67 join meta.app a on a.id = p.app_id and a.alias = 'hr';

insert into meta.static_file (app_id, name, mime, content)
select a.id, 'hr-import.js', 'text/javascript', convert_to($js$// HR example, page 67: the Ajax callback LOOKUP_CONTACT (a chain of two SQL processes).
// The web request its first step queues is made before its second step runs: one call, no polling.
pgkiln.actions.register('hr.lookupContact', async () => {
  if (!pgkiln.getValue('P67_CRM_ID')) return pgkiln.showError('Enter a contact number.', 'P67_CRM_ID');
  const r = await pgkiln.server.process('LOOKUP_CONTACT', { items: ['P67_CRM_ID'] });
  if (r.data && r.data.found) pgkiln.showSuccess(r.data.p67_crm_found);
  else pgkiln.showError((r.data && r.data.p67_crm_found) || 'Not found.', 'P67_CRM_ID');
});
$js$, 'utf8')
  from meta.app a where a.alias = 'hr';
update meta.app set static_includes = array_append(static_includes, 'hr-import.js') where alias = 'hr';

-- page 35 opens the dialog
insert into meta.button (page_id, region_id, seq, name, label, action, target_page)
select p.id, r.id, 40, 'IMPORT_CONTACTS', 'Import contacts', 'redirect', 67
  from meta.page p join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = 'Call a web service'
 where p.page_no = 35;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Import contacts', 'Contacten importeren'),
  ('Contacts to import', 'Te importeren contacten'),
  ('CSV file', 'CSV-bestand'),
  ('Read the file', 'Bestand inlezen'),
  ('Start over', 'Opnieuw beginnen'),
  ('Import', 'Importeren'),
  ('Look up a CRM contact', 'Een CRM-contact opzoeken'),
  ('Contact number', 'Contactnummer'),
  ('Found', 'Gevonden'),
  ('In the CRM', 'In het CRM'),
  ('Look up', 'Opzoeken'),
  ('Count the CRM''s contacts', 'Contacten in het CRM tellen'),
  ('Choose a CSV file first.', 'Kies eerst een CSV-bestand.'),
  ('The file is read: check the lines below, then Import.', 'Het bestand is ingelezen: controleer de regels hieronder en kies Importeren.'),
  ('The lines are removed.', 'De regels zijn verwijderd.'),
  ('The contacts are imported into the CRM.', 'De contacten zijn in het CRM geïmporteerd.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
