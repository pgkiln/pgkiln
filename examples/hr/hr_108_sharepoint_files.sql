-- =====================================================================
-- HR example, part 108: files in OneDrive / SharePoint (sprint 244,
-- MG-29; docs/guide/16-files.md "OneDrive and SharePoint").
--
-- Page 77 "Policy documents" (Administration, administrators only): HR's
-- policy documents live in a SharePoint document library, where the
-- office edits them, and pgkiln keeps a row per document in
-- hr.policy_document. The file item P77_FILE stores its files with the
-- object store provider "graph" (Microsoft Graph): each upload goes to the
-- folder "HR/Policies" of the drive; the row keeps the drive item's id.
-- Files over 4 MB go through an upload session in ranges. Downloads go
-- through pgkiln (the row passes RLS, the link carries the user's
-- checksum); a replaced or removed file, or that of a deleted record, is
-- deleted from the library after the save.
--
-- Nothing is sent until an administrator sets it up:
--   1. In Microsoft Entra ID, register an application with the application
--      permission Files.ReadWrite.All (or Sites.Selected, granted to the
--      one site) and create a client secret.
--   2. Shared Components → Web credentials → MS_GRAPH: replace <tenant> in
--      the token URL with the tenant id, and enter the client id and secret.
--   3. In page 77's P77_FILE attributes, set "drive" to the library's drive
--      id (GET /sites/{site}/drives in Graph Explorer), or use "site".
--   4. Allow the hosts in .env:
--        PGKILN_REST_ALLOWED_HOSTS=graph.microsoft.com,login.microsoftonline.com,*.sharepoint.com
-- Until then an upload is refused with the reason (the credential has no
-- secret yet) and nothing is saved.
-- =====================================================================

create table hr.policy_document (
  id          int generated always as identity primary key,
  title       text not null,
  file_key    text,
  file_name   text,
  file_mime   text,
  file_size   bigint,
  updated_at  timestamptz not null default now(),
  updated_by  text not null default meta.app_user()
);
grant select, insert, update, delete on hr.policy_document to hr_app;
alter table hr.policy_document enable row level security;
-- every employee may read the policies (a later page could list them); only administrators change them
create policy policy_document_read on hr.policy_document for select using (true);
create policy policy_document_write on hr.policy_document for all using (meta.has_role('admin')) with check (meta.has_role('admin'));

insert into meta.web_credential (app_id, name, description, type, username, token_url, scope, grant_type, valid_for)
select id, 'MS_GRAPH',
       'Microsoft Graph, app-only (client credentials): HR''s SharePoint library for policy documents (page 77). Enter the tenant in the token URL, the client id and the client secret of an Entra ID application with Files.ReadWrite.All or Sites.Selected.',
       'oauth2', '00000000-0000-0000-0000-000000000000', 'https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token',
       'https://graph.microsoft.com/.default', 'client_credentials', '{https://graph.microsoft.com/}'
  from meta.app where alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page, authz)
select id, 77, 'Policy documents', 'Policy documents', 1, 'ADMIN' from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, source, config, table_name, pk_column, pk_item)
select p.id, r.seq, r.title, r.type, r.source, r.config::jsonb, r.tbl, r.pk, r.pk_item
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Policies in SharePoint', 'static',
   '<p>The files of these documents are kept in the SharePoint library <b>HR/Policies</b> through Microsoft Graph (object store provider <code>graph</code>); the table keeps the drive item''s id. Downloads go through this application. An administrator sets up the web credential <b>MS_GRAPH</b> and the library''s drive id first (see part 108 of the HR example).</p>',
   '{}', null, null, null),
  (20, 'Documents', 'report',
   E'select id, title, file_name as file, file_size as bytes, updated_at as updated, updated_by as by\n  from hr.policy_document\n order by title',
   '{"page_size": 10, "link": {"column": "id", "page": 77, "items": {"P77_ID": "#id#"}}, "empty": "No policy documents yet."}', null, null, null),
  (30, 'Document', 'form', null, '{}', 'hr.policy_document', 'id', 'P77_ID')
  ) as r (seq, title, type, source, config, tbl, pk, pk_item)
 where a.alias = 'hr' and p.page_no = 77;

insert into meta.item (page_id, region_id, seq, name, label, type, source_column, required, config, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.col, i.req, i.config::jsonb, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Document', (values
  (10, 'P77_ID', null, 'hidden', 'id', false, '{}', null),
  (20, 'P77_TITLE', 'Title', 'text', 'title', true, '{}', null),
  (30, 'P77_FILE', 'File', 'file', 'file_key', false,
   '{"object_store": {"provider": "graph", "drive": "b!your-document-library-drive-id", "folder": "HR/Policies", "credential": "MS_GRAPH"},
     "filename_column": "file_name", "mime_column": "file_mime", "size_column": "file_size", "max_mb": 10,
     "accept": ".pdf,.doc,.docx,.odt"}',
   'A PDF or Word file; it is stored in the SharePoint library HR/Policies.')
  ) as i (seq, name, label, type, col, req, config, help)
 where a.alias = 'hr' and p.page_no = 77;

insert into meta.button (page_id, region_id, seq, name, label, action, target_page, condition, hot, confirm)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.target, b.cond, b.hot, b.confirm
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Document', (values
  (10, 'NEW', 'New document', 'redirect', 77, ':P77_ID is not null', false, null),
  (20, 'DELETE', 'Delete', 'submit', null, ':P77_ID is not null', false, 'Delete this document and its file in SharePoint?'),
  (30, 'SAVE', 'Save', 'submit', null, ':P77_ID is not null', true, null),
  (40, 'CREATE', 'Add document', 'submit', null, ':P77_ID is null', true, null)
  ) as b (seq, name, label, action, target, cond, hot, confirm)
 where a.alias = 'hr' and p.page_no = 77;

insert into meta.process (page_id, seq, name, type, region_id)
select p.id, 10, 'Save the document', 'form_dml', r.id
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Document'
 where a.alias = 'hr' and p.page_no = 77;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page, authz)
select a.id, n.id, 77, 'Policy documents', 'file', 77, 'ADMIN'
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Policy documents', 'Beleidsdocumenten'),
  ('Policies in SharePoint', 'Beleid in SharePoint'),
  ('Documents', 'Documenten'),
  ('Document', 'Document'),
  ('New document', 'Nieuw document'),
  ('Add document', 'Document toevoegen'),
  ('No policy documents yet.', 'Nog geen beleidsdocumenten.'),
  ('Delete this document and its file in SharePoint?', 'Dit document en zijn bestand in SharePoint verwijderen?')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
