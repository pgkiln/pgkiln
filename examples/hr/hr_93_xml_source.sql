-- =====================================================================
-- HR example, part 93: a REST data source of XML (sprint 224; APEX: REST
-- data sources of XML and SOAP services; docs/guide/19-rest-data-sources.md
-- "XML and SOAP")
--
-- The HR API (part 13) gets a public media handler GET departments.xml that
-- answers XML made with PostgreSQL's own XML functions. The REST data source
-- DEPARTMENTS_XML reads it: the row selector departments.department picks
-- the repeating element, the columns read an attribute (@id) and child
-- elements, exactly as paths read JSON. Page 23 (Web services) shows it in
-- the report "Departments as XML". As for part 23, the server calls
-- 127.0.0.1 only when PGKILN_REST_ALLOWED_HOSTS and PGKILN_REST_PRIVATE_HOSTS
-- allow it.
-- =====================================================================
update meta.rest_module m
   set handlers = m.handlers || $h$[
  {"method": "GET", "path": "departments.xml", "type": "media", "auth": "public", "description": "The departments as XML (no token needed)",
   "source": "select 'application/xml' as content_type, xmlserialize(document xmlroot(xmlelement(name departments, xmlagg(xmlelement(name department, xmlattributes(deptno as id), xmlelement(name name, dname), xmlelement(name location, initcap(loc))) order by deptno)), version '1.0') as text) as content from hr.dept"}
]$h$::jsonb
  from meta.app a
 where a.id = m.app_id and a.alias = 'hr' and m.name = 'v1'
   and not m.handlers @> '[{"path": "departments.xml"}]';

insert into meta.rest_source (app_id, name, description, url, params, row_selector, columns, cache_seconds)
select id, 'DEPARTMENTS_XML', 'All departments, read from XML (public endpoint).', 'http://127.0.0.1:3100/a/hr/rest/v1/departments.xml', '[]'::jsonb,
       'departments.department',
       '[{"name": "deptno", "path": "@id", "type": "integer"}, {"name": "dname", "path": "name", "type": "text"}, {"name": "location", "type": "text"}]'::jsonb, 60
  from meta.app where alias = 'hr'
on conflict do nothing;

insert into meta.region (page_id, seq, title, type, columns, template, source, rest_source, config)
select p.id, 25, 'Departments as XML', 'report', 4, 'standard', 'select dname, location from rest order by deptno', 'DEPARTMENTS_XML',
       '{"page_size": 10, "headings": {"dname": "Department", "location": "Location"}}'::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 23
   and not exists (select 1 from meta.region r where r.page_id = p.id and r.title = 'Departments as XML');

insert into meta.translation (app_id, language, source, target)
select id, 'nl', 'Departments as XML', 'Afdelingen als XML' from meta.app where alias = 'hr'
on conflict do nothing;
