-- =====================================================================
-- HR example, part 38: the PL/SQL API equivalents meta.parse_data
-- (APEX_DATA_PARSER) and meta.web_request (APEX_WEB_SERVICE)
-- (docs/guide/09-reference.md, "Parsing files" and "Web requests from SQL")
--
-- Page 35 "Parse and fetch":
--   - "Parse a file": paste CSV, TSV or JSON; the two reports show what
--     meta.parse_data_columns (names, headings, inferred types) and
--     meta.parse_data (the rows) make of it, all in SQL;
--   - "Call a web service": "Fetch the contacts" runs two page processes:
--     the first queues a request to the sample CRM of part 37 with
--     meta.web_request(); the server makes it right after that process
--     (in the same submit), so the second process reads the response with
--     meta.web_response() and the report lists the contacts it returned.
--     As for page 34 the server must allow the host, e.g. in .env:
--
--       PGAPEX_REST_ALLOWED_HOSTS=127.0.0.1
--       PGAPEX_REST_PRIVATE_HOSTS=127.0.0.1
--
--     Without them the request ends with status "error" and the message
--     says why (the host is not on the allow-list).
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 35, 'Parse and fetch', 'Parse and fetch', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Parse a file', 'static', 12,
   '<p>Paste CSV (comma, semicolon, tab or bar separated, the first line holds the headings), or JSON (an array of objects or JSON Lines), and choose <b>Parse</b>. <code>meta.parse_data()</code> reads it in SQL, with the same rules as the data loader.</p>',
   '{}'),
  (20, 'Columns', 'report', 6,
   'select column_position as "#", column_name, heading, data_type from meta.parse_data_columns(convert_to(:P35_TEXT, ''UTF8''))',
   '{"page_size": 20, "headings": {"column_name": "Column", "heading": "Heading", "data_type": "Type"}}'),
  (30, 'Rows', 'report', 6,
   'select line_number, array_to_string(cols, '' · '', ''–'') as "values" from meta.parse_data(convert_to(:P35_TEXT, ''UTF8''))',
   '{"page_size": 10, "headings": {"line_number": "Line", "values": "Values"}}'),
  (40, 'Call a web service', 'static', 12,
   '<p><b>Fetch the contacts</b> queues a request to the sample CRM (page 34) with <code>meta.web_request()</code>. The server makes it right after the page process that queued it, so the next process reads the response with <code>meta.web_response()</code>. Outside page processes (automations, workflows) requests are made by the scheduler after the transaction commits.</p>',
   '{}'),
  (50, 'Contacts in the response', 'report', 12,
   $q$select c.id, c.name, c.company, c.email
  from jsonb_to_recordset(coalesce(meta.web_response(nullif(:P35_REQUEST, '')::bigint) -> 'json' -> 'items', '[]')) as c (id int, name text, company text, email text)
 order by c.id$q$,
   '{"page_size": 10, "headings": {"id": "No.", "name": "Name", "company": "Company", "email": "E-mail"}, "empty": "No response yet: choose Fetch the contacts."}')
  ) as r (seq, title, type, columns, source, config)
 where a.alias = 'hr' and p.page_no = 35;

insert into meta.item (page_id, region_id, seq, name, label, type, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.help
  from (values
  (10, 'Parse a file', 'P35_TEXT', 'File contents', 'textarea', 'CSV, TSV or JSON text.'),
  (20, 'Call a web service', 'P35_REQUEST', 'Request', 'hidden', null),
  (30, 'Call a web service', 'P35_STATUS', 'Result', 'display', 'The status of the request: the HTTP status code, or error with the reason.')
  ) as i (seq, region, name, label, type, help)
  join meta.page p on p.page_no = 35 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = i.region;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, b.seq, b.name, b.label, 'submit', b.hot
  from (values
  (10, 'Parse a file', 'PARSE', 'Parse', true),
  (20, 'Call a web service', 'FETCH', 'Fetch the contacts', false)
  ) as b (seq, region, name, label, hot)
  join meta.page p on p.page_no = 35 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = b.region;

insert into meta.process (page_id, seq, name, type, point, code, when_button)
select p.id, x.seq, x.name, 'sql', x.point, x.code, x.btn
  from (values
  (10, 'Sample file', 'load',
   $c$select coalesce(:P35_TEXT, E'Name;Hire date;Salary;Remote\nAda Byron;2024-02-01;5200.50;yes\n"Hopper; Grace";2023-11-15;6100;no\nAlan Turing;2022-06-23;4800;yes') as p35_text$c$, null),
  -- the server makes the request right after this process (same transaction)
  (20, 'Queue the request', 'submit',
   $c$select meta.web_request(current_setting('pgapex.public_url') || '/a/hr/rest/crm/contacts', p_timeout_s => 10) as p35_request$c$, 'FETCH'),
  (30, 'Read the response', 'submit',
   $c$select case r ->> 'status' when 'ok' then 'HTTP ' || (r ->> 'status_code') else (r ->> 'status') || ': ' || coalesce(r ->> 'message', '') end as p35_status
  from meta.web_response(:P35_REQUEST::bigint) r$c$, 'FETCH')
  ) as x (seq, name, point, code, btn)
  join meta.page p on p.page_no = 35 join meta.app a on a.id = p.app_id and a.alias = 'hr';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 27, 'Parse and fetch', 'download', 35 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Parse and fetch', 'Inlezen en ophalen'),
  ('Parse a file', 'Een bestand inlezen'),
  ('Parse', 'Inlezen'),
  ('Columns', 'Kolommen'),
  ('Rows', 'Rijen'),
  ('File contents', 'Inhoud van het bestand'),
  ('Call a web service', 'Een webservice aanroepen'),
  ('Fetch the contacts', 'Contacten ophalen'),
  ('Contacts in the response', 'Contacten in het antwoord'),
  ('Result', 'Resultaat')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
