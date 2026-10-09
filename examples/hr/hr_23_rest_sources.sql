-- =====================================================================
-- HR example, part 23: REST data sources, web credentials, Invoke API
-- (docs/guide/19-rest-data-sources.md)
--
-- The web service is the HR example's own REST module (part 13), served by
-- the pgkiln server on http://127.0.0.1:3100, so no internet is needed.
-- Outgoing calls are off until the server allows the host, e.g. in .env:
--
--   PGKILN_REST_ALLOWED_HOSTS=127.0.0.1
--   PGKILN_REST_PRIVATE_HOSTS=127.0.0.1     (127.0.0.1 is a loopback address)
--
-- (another port or host: change the URLs under Shared Components → REST
-- data sources). Page 23 "Web services" then shows:
--   - a report and cards whose rows come from GET departments (cached 60 s),
--   - a select list whose list of values reads the same source,
--   - "Look up": an invoke_api process that calls GET departments/{deptno}
--     with the selected department and puts the answer into two items.
-- The web credential HR_API (OAuth2 client credentials against pgkiln's own
-- /oauth/token) and the source EMPLOYEES_API show a protected endpoint:
-- create an OAuth client under App → REST API, put its client id in HR_API
-- and type its secret there (secrets are never part of SQL or exports).
-- =====================================================================

-- a public endpoint for one department
update meta.rest_module m
   set handlers = m.handlers || $h$[
  {"method": "GET", "path": "departments/:deptno", "type": "item", "auth": "public", "description": "One department (no token needed)",
   "source": "select deptno, dname, initcap(loc) as location from hr.dept where deptno = :DEPTNO::int"}
]$h$::jsonb
  from meta.app a
 where a.id = m.app_id and a.alias = 'hr' and m.name = 'v1';

insert into meta.web_credential (app_id, name, description, type, username, token_url, valid_for)
select id, 'HR_API', 'OAuth2 client credentials for the HR API (enter the client id and secret of an OAuth client from App → REST API).',
       'oauth2', 'hr-integration', 'http://127.0.0.1:3100/oauth/token', '{http://127.0.0.1:3100/a/hr/rest/}'
  from meta.app where alias = 'hr';

insert into meta.rest_source (app_id, name, description, url, params, row_selector, columns, cache_seconds, credential)
select a.id, s.name, s.description, s.url, s.params::jsonb, s.row_selector, s.columns::jsonb, s.cache_seconds, s.credential
  from meta.app a, (values
  ('DEPARTMENTS', 'All departments (public endpoint).', 'http://127.0.0.1:3100/a/hr/rest/v1/departments', '[]', 'items',
   '[{"name": "deptno", "type": "integer"}, {"name": "dname", "type": "text"}, {"name": "location", "type": "text"}]', 60, null),
  ('DEPARTMENT', 'One department by number (public endpoint).', 'http://127.0.0.1:3100/a/hr/rest/v1/departments/{deptno}',
   '[{"name": "deptno", "in": "path", "required": true}]', null,
   '[{"name": "deptno", "type": "integer"}, {"name": "dname", "type": "text"}, {"name": "location", "type": "text"}]', 0, null),
  ('EMPLOYEES_API', 'The active employees (needs the HR_API credential).', 'http://127.0.0.1:3100/a/hr/rest/v1/employees',
   '[{"name": "limit", "in": "query", "default": "100"}]', 'items',
   '[{"name": "empno", "type": "integer"}, {"name": "name", "type": "text"}, {"name": "job", "type": "text"}, {"name": "deptno", "type": "integer"}]', 0, 'HR_API')
  ) as s (name, description, url, params, row_selector, columns, cache_seconds, credential)
 where a.alias = 'hr';

insert into meta.lov (app_id, name, query, rest_source)
select id, 'DEPARTMENTS_REST', 'select dname, deptno from rest order by dname', 'DEPARTMENTS'
  from meta.app where alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 23, 'Web services', 'Web services', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, rest_source, config)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.rest_source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'About this page', 'static', 12, null,
   '<p>The regions below read the HR REST API through <b>REST data sources</b> (Shared Components). The server only calls hosts it allows: set <code>PGKILN_REST_ALLOWED_HOSTS</code> and <code>PGKILN_REST_PRIVATE_HOSTS</code> to <code>127.0.0.1</code> to try it.</p>',
   '{}'),
  (20, 'Departments from the API', 'report', 8, 'DEPARTMENTS',
   'select deptno, dname, location from rest order by dname',
   '{"page_size": 10, "headings": {"deptno": "Number", "dname": "Department", "location": "Location"}}'),
  (30, 'Locations', 'cards', 4, 'DEPARTMENTS',
   'select initcap(dname) as title, location as subtitle, ''map'' as icon from rest order by location',
   '{}'),
  (40, 'Look up a department', 'form', 12, null, null, '{}')
  ) as r (seq, title, type, columns, rest_source, source, config)
 where a.alias = 'hr' and p.page_no = 23;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.lov, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Look up a department', (values
  (10, 'P23_DEPTNO', 'Department', 'select', 'LOV:DEPARTMENTS_REST', 'The list of values reads the DEPARTMENTS REST data source.'),
  (20, 'P23_DNAME', 'Name (from the API)', 'display', null, null),
  (30, 'P23_LOCATION', 'Location (from the API)', 'display', null, null)
  ) as i (seq, name, label, type, lov, help)
 where a.alias = 'hr' and p.page_no = 23;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 10, 'LOOKUP', 'Look up', 'submit', true
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.title = 'Look up a department'
 where a.alias = 'hr' and p.page_no = 23;

insert into meta.validation (page_id, seq, name, item_name, type, message, when_button)
select p.id, 10, 'Department chosen', 'P23_DEPTNO', 'not_null', 'Choose a department.', 'LOOKUP'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 23;

insert into meta.process (page_id, seq, name, type, point, when_button, config, success_message)
select p.id, 10, 'Call the HR API', 'invoke_api', 'submit', 'LOOKUP',
       '{"source": "DEPARTMENT", "params": {"deptno": "&P23_DEPTNO."}, "items": {"P23_DNAME": "dname", "P23_LOCATION": "location"}}'::jsonb,
       'The API answered.'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 23;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 25, 'Web services', 'database', 23 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Web services', 'Webservices'),
  ('About this page', 'Over deze pagina'),
  ('Departments from the API', 'Afdelingen uit de API'),
  ('Locations', 'Locaties'),
  ('Look up a department', 'Een afdeling opzoeken'),
  ('Name (from the API)', 'Naam (uit de API)'),
  ('Location (from the API)', 'Locatie (uit de API)'),
  ('Look up', 'Opzoeken'),
  ('Choose a department.', 'Kies een afdeling.'),
  ('The API answered.', 'De API heeft geantwoord.'),
  ('Number', 'Nummer'),
  ('Department', 'Afdeling'),
  ('Location', 'Locatie')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
