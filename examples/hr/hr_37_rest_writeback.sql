-- =====================================================================
-- HR example, part 37: a REST data source that writes back and is
-- synchronised into a local table (docs/guide/19-rest-data-sources.md)
--
-- The "external system" is a small contact list (hr.crm_contact) behind a
-- REST module of the HR example itself (/a/hr/rest/crm/contacts: GET, POST,
-- PUT, DELETE), so no internet is needed. Its handlers are public because
-- this is a demonstration on a sample table; a real service would use a web
-- credential. As for page 23, the server must allow the host, e.g. in .env:
--
--   PGKILN_REST_ALLOWED_HOSTS=127.0.0.1
--   PGKILN_REST_PRIVATE_HOSTS=127.0.0.1
--
-- Page 34 "Contacts (REST)" shows:
--   - an interactive grid on the REST data source CRM_CONTACTS: Add, Save
--     and Delete go to the service through the source's operations;
--   - a form on the same source: "Edit" in a grid row loads the contact
--     (the source's fetch operation), Save / Create / Delete write it back;
--   - the local copy hr.crm_contact_copy, filled by the source's
--     synchronisation (merge on id, deleting contacts the service no longer
--     has): "Synchronise" queues a run with meta.request_rest_sync(), which
--     the server's scheduler runs within half a minute. The source also has
--     a schedule (every 15 minutes), switched off: switch it on under
--     Shared Components → REST data sources → CRM_CONTACTS.
-- =====================================================================

create table hr.crm_contact (
  id       serial primary key,
  name     text not null,
  company  text,
  email    text,
  phone    text
);
grant select, insert, update, delete on hr.crm_contact to hr_app;
grant usage on sequence hr.crm_contact_id_seq to hr_app;

insert into hr.crm_contact (name, company, email, phone) values
  ('Ada Byron', 'Analytical Engines', 'ada@example.com', '+44 20 7946 0001'),
  ('Grace Hopper', 'Compilers Inc.', 'grace@example.com', '+1 202 555 0102'),
  ('Alan Turing', 'Bletchley Labs', 'alan@example.com', '+44 1908 640404'),
  ('Edsger Dijkstra', 'Shortest Path BV', 'edsger@example.com', '+31 40 247 9111');

-- the local copy (written by the synchronisation as hr_app)
create table hr.crm_contact_copy (
  id         int primary key,
  name       text not null,
  company    text,
  email      text,
  synced_at  timestamptz not null default now()
);
grant select, insert, update, delete on hr.crm_contact_copy to hr_app;

-- the "external" service: a REST module with public handlers (demonstration only)
insert into meta.rest_module (app_id, name, title, description, handlers)
select id, 'crm', 'Sample CRM', 'A sample contact list that stands in for an external system (REST data source CRM_CONTACTS writes back to it).',
$h$[
  {"method": "GET", "path": "contacts", "type": "collection", "auth": "public", "page_size": 500, "description": "The contacts",
   "source": "select id, name, company, email, phone from hr.crm_contact order by id"},
  {"method": "GET", "path": "contacts/:id", "type": "item", "auth": "public", "description": "One contact",
   "source": "select id, name, company, email, phone from hr.crm_contact where id = :ID::int"},
  {"method": "POST", "path": "contacts", "type": "sql", "auth": "public", "status": 201, "description": "Add a contact",
   "source": "insert into hr.crm_contact (name, company, email, phone) values (:NAME, :COMPANY, :EMAIL, :PHONE) returning id, name, company, email, phone"},
  {"method": "PUT", "path": "contacts/:id", "type": "sql", "auth": "public", "description": "Replace a contact",
   "source": "update hr.crm_contact set name = :NAME, company = :COMPANY, email = :EMAIL, phone = :PHONE where id = :ID::int returning id, name, company, email, phone"},
  {"method": "DELETE", "path": "contacts/:id", "type": "sql", "auth": "public", "description": "Delete a contact",
   "source": "delete from hr.crm_contact where id = :ID::int"}
]$h$::jsonb
  from meta.app where alias = 'hr';

insert into meta.rest_source (app_id, name, description, url, row_selector, columns, key_columns, operations,
                              sync_table, sync_mode, sync_delete, sync_schedule, sync_time_zone, sync_enabled)
select id, 'CRM_CONTACTS', 'Contacts of the sample CRM: read, written back and synchronised into hr.crm_contact_copy.',
       'http://127.0.0.1:3100/a/hr/rest/crm/contacts', 'items',
       '[{"name": "id", "type": "integer"}, {"name": "name", "type": "text"}, {"name": "company", "type": "text"},
         {"name": "email", "type": "text"}, {"name": "phone", "type": "text"}]',
       '{id}',
       '{"insert": {"method": "POST"},
         "update": {"method": "PUT", "path": "/{id}"},
         "delete": {"method": "DELETE", "path": "/{id}"},
         "fetch":  {"method": "GET", "path": "/{id}"}}',
       'hr.crm_contact_copy', 'merge', true, '*/15 * * * *', 'UTC', false
  from meta.app where alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 34, 'Contacts (REST)', 'Contacts (REST)', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, rest_source, pk_column, pk_item, config)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.rest_source, r.pk_column, r.pk_item, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'About this page', 'static', 12, null, null, null,
   '<p>The grid and the form read and write the contacts of a sample CRM through the <b>REST data source</b> CRM_CONTACTS (Shared Components): Add, Save and Delete call the service''s POST, PUT and DELETE. The report at the bottom is a local copy, filled by the source''s <b>synchronisation</b>. Set <code>PGKILN_REST_ALLOWED_HOSTS</code> and <code>PGKILN_REST_PRIVATE_HOSTS</code> to <code>127.0.0.1</code> to try it.</p>',
   '{}'),
  (20, 'Contacts in the CRM', 'grid', 12, 'CRM_CONTACTS', 'id', null,
   'select id, name, company, email, phone from rest order by id',
   '{"page_size": 10, "headings": {"id": "No.", "name": "Name", "company": "Company", "email": "E-mail", "phone": "Phone"},
     "columns": {"name": {"required": true}},
     "row_actions": {"edit": {"page": 34, "items": {"P34_ID": "#id#"}}, "delete": true}}'),
  (30, 'Edit a contact', 'form', 12, 'CRM_CONTACTS', 'id', 'P34_ID', null, '{}'),
  (40, 'Local copy (synchronised)', 'report', 12, null, null, null,
   'select id, name, company, email, synced_at from hr.crm_contact_copy order by id',
   '{"page_size": 10, "headings": {"id": "No.", "name": "Name", "company": "Company", "email": "E-mail", "synced_at": "Synchronised"}}')
  ) as r (seq, title, type, columns, rest_source, pk_column, pk_item, source, config)
 where a.alias = 'hr' and p.page_no = 34;

insert into meta.item (page_id, region_id, seq, name, label, type, source_column, required, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.col, i.req, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Edit a contact', (values
  (10, 'P34_ID', 'Number', 'hidden', 'id', false, null),
  (20, 'P34_NAME', 'Name', 'text', 'name', false, 'Choose "Edit" in a row of the grid, or fill in a new contact and choose Create.'),
  (30, 'P34_COMPANY', 'Company', 'text', 'company', false, null),
  (40, 'P34_EMAIL', 'E-mail', 'email', 'email', false, null),
  (50, 'P34_PHONE', 'Phone', 'tel', 'phone', false, null)
  ) as i (seq, name, label, type, col, req, help)
 where a.alias = 'hr' and p.page_no = 34;

insert into meta.button (page_id, region_id, seq, name, label, action, hot, condition)
select p.id, r.id, b.seq, b.name, b.label, 'submit', b.hot, b.cond
  from (values
  (10, 'Edit a contact', 'SAVE', 'Save', true, ':P34_ID is not null'),
  (20, 'Edit a contact', 'CREATE', 'Create', true, ':P34_ID is null'),
  (30, 'Edit a contact', 'DELETE', 'Delete', false, ':P34_ID is not null'),
  (10, 'Local copy (synchronised)', 'SYNC', 'Synchronise', false, null)
  ) as b (seq, region, name, label, hot, cond)
  join meta.page p on p.page_no = 34 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = b.region;

-- the name is needed when the form is saved (not when the grid is: both are on this page)
insert into meta.validation (page_id, seq, name, item_name, type, message, when_button)
select p.id, v.seq, 'Name given', 'P34_NAME', 'not_null', 'Enter a name.', v.btn
  from meta.page p join meta.app a on a.id = p.app_id, (values (10, 'SAVE'), (20, 'CREATE')) as v (seq, btn)
 where a.alias = 'hr' and p.page_no = 34;

insert into meta.process (page_id, seq, name, type, region_id, code, when_button, success_message)
select p.id, x.seq, x.name, x.type, r.id, x.code, x.when_button, x.msg
  from (values
  (10, 'Save the grid', 'grid_dml', 'Contacts in the CRM', null, null, null),
  (20, 'Save the contact', 'form_dml', 'Edit a contact', null, null, null),
  (30, 'Synchronise the copy', 'sql', null, 'select meta.request_rest_sync(''CRM_CONTACTS'')', 'SYNC',
   'Synchronisation queued: the server copies the contacts within half a minute (reload the page).')
  ) as x (seq, name, type, region, code, when_button, msg)
  join meta.page p on p.page_no = 34 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  left join meta.region r on r.page_id = p.id and r.title = x.region;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 26, 'Contacts (REST)', 'database', 34 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Contacts (REST)', 'Contacten (REST)'),
  ('Contacts in the CRM', 'Contacten in het CRM'),
  ('Edit a contact', 'Een contact bewerken'),
  ('Local copy (synchronised)', 'Lokale kopie (gesynchroniseerd)'),
  ('Company', 'Bedrijf'),
  ('Phone', 'Telefoon'),
  ('Synchronise', 'Synchroniseren'),
  ('Synchronised', 'Gesynchroniseerd'),
  ('Enter a name.', 'Vul een naam in.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
