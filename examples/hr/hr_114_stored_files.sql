-- =====================================================================
-- HR example, part 114: stored files in PDFs and mails, a folder per
-- record (sprint 253, MG-30 and MG-31; docs/guide/16-files.md "Stored
-- files in documents and mails", "A folder per record").
--
-- Page 77 "Policy documents" (part 108) keeps its files in SharePoint.
-- - P77_FILE's folder becomes "HR/Policies/&P77_TITLE.": each document gets
--   a folder of its own, named after its title at upload time (made safe:
--   no "/", no "..", an empty title gives "_"). Downloads and deletes reach
--   any file below "HR/Policies", nothing outside it.
-- - The document template POLICY_SHEET (button "Print") shows the file in
--   the PDF when it is a PNG or JPEG: <img src="stored:P77_FILE:{{image_key}}">.
--   The server fetches it from SharePoint while drawing; a file that is
--   missing (or SharePoint not set up yet) is left out of the PDF.
-- - The button "Mail to me" sends the document to the signed-in user with
--   the file attached by reference: meta.add_mail_attachment_stored. The
--   mail sender fetches the file when it sends the mail.
-- Which rows (keys) the template's query and the process reach is up to
-- hr.policy_document's row level security: they run as hr_app.
-- =====================================================================

update meta.item i set config = jsonb_set(config, '{object_store,folder}', '"HR/Policies/&P77_TITLE."') || '{"accept": ".pdf,.doc,.docx,.odt,.png,.jpg,.jpeg"}',
       help = 'A PDF, Word file or picture; it is stored in the SharePoint library, in HR/Policies/<the title>.'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 77 and i.name = 'P77_FILE';

insert into meta.document_template (app_id, name, description, query, template, filename)
select id, 'POLICY_SHEET', 'Policy sheet',
$q$select title, file_name, updated_at::date as updated, updated_by,
       case when file_mime in ('image/png', 'image/jpeg') then file_key end as image_key
  from hr.policy_document
 where id = :P77_ID::int$q$,
$t$<img src="logo" align="right" width="30mm">
<h1>{{title}}</h1>
<p class="muted">{{file_name|default:No file}} · updated {{updated}} by {{updated_by}}</p>
{{#image_key}}<img src="stored:P77_FILE:{{image_key}}" width="120mm">{{/image_key}}$t$,
'policy-&P77_ID.'
  from meta.app where alias = 'hr';

insert into meta.button (page_id, region_id, seq, name, label, action, document, condition)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.doc, b.cond
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Document', (values
  (25, 'PRINT', 'Print', 'document', 'POLICY_SHEET', ':P77_ID is not null'),
  (27, 'MAIL', 'Mail to me', 'submit', null, ':P77_ID is not null')
  ) as b (seq, name, label, action, doc, cond)
 where a.alias = 'hr' and p.page_no = 77;

insert into meta.process (page_id, seq, name, type, code, point, when_button, success_message)
select p.id, 20, 'Mail the document', 'sql',
$c$select meta.add_mail_attachment_stored(
         meta.send_mail(lower(:APP_USER) || '@example.com', 'Policy: ' || title, 'The policy document is attached.'),
         'P77_FILE', file_key, file_name, file_mime)
  from hr.policy_document
 where id = :P77_ID::int and file_key is not null$c$,
       'submit', 'MAIL', 'The document is on its way.'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 77;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Mail to me', 'Mail naar mij'),
  ('The document is on its way.', 'Het document is onderweg.'),
  ('Policy sheet', 'Beleidsblad')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
