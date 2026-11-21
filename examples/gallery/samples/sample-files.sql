-- =====================================================================
-- Sample app "Sample Files" (App Gallery → Sample Apps)
--
-- File upload and download: a file per record in the table's own columns
-- (name, type, size and date kept beside it), several files per record in a
-- child table, and a picture cropped in the browser before it is uploaded.
-- Folders, people and site visits share one picture table (related_type +
-- related_id), shown as a gallery of thumbnails; the site visit page saves
-- with its own processes, its gallery names the key item (parent_item).
-- Every download link is bound to the user and the record; files are read
-- as the application's role and sent as attachments.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-files.sql
-- then open /a/sample-files and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_files;

create table sample_files.document (
  id        int generated always as identity primary key,
  title     text not null,
  category  text not null default 'General' check (category in ('General', 'Contract', 'Invoice', 'Manual')),
  content   bytea check (octet_length(content) <= 5 * 1024 * 1024),
  filename  text,
  mime_type text,
  file_size int,
  updated   timestamptz
);

insert into sample_files.document (title, category, content, filename, mime_type, file_size, updated)
select t, c, convert_to(body, 'utf8'), f, 'text/plain', octet_length(convert_to(body, 'utf8')), now()
  from (values
  ('Read me', 'General', 'readme.txt', E'Sample Files\n\nUpload a PDF, a picture or a text file on the document form.\n'),
  ('Opening hours', 'Manual', 'opening-hours.txt', E'Monday to Friday 9:00-17:00\nSaturday 10:00-14:00\n')
  ) as d (t, c, f, body);
insert into sample_files.document (title, category) values ('Supplier contract (no file yet)', 'Contract');

create table sample_files.folder (
  id          int generated always as identity primary key,
  name        text not null unique,
  description text
);

create table sample_files.attachment (
  id        int generated always as identity primary key,
  folder_id int not null references sample_files.folder on delete cascade,
  filename  text not null,
  mime_type text not null,
  content   bytea not null check (octet_length(content) <= 5 * 1024 * 1024)
);

insert into sample_files.folder (name, description) values
  ('Project Alpha', 'Plans and minutes'), ('Office move', 'Floor plans and the moving checklist');
insert into sample_files.attachment (folder_id, filename, mime_type, content)
select f.id, a.filename, 'text/plain', convert_to(a.body, 'utf8')
  from sample_files.folder f join (values
  ('Project Alpha', 'minutes-week-1.txt', E'Kick-off: scope agreed, next meeting Thursday.\n'),
  ('Project Alpha', 'plan.txt', E'1. Design\n2. Build\n3. Test\n'),
  ('Office move', 'checklist.txt', E'- Boxes\n- Labels\n- Network\n')
  ) as a (folder, filename, body) on a.folder = f.name;

create table sample_files.person (
  id         int generated always as identity primary key,
  name       text not null,
  photo      bytea check (octet_length(photo) <= 2 * 1024 * 1024),
  photo_name text,
  photo_mime text
);
insert into sample_files.person (name) values ('Ada'), ('Grace'), ('Linus');

-- pictures of folders and people in one shared table: related_type says which kind of record, related_id (text) its id;
-- there is no foreign key, so each file item names its kind with "filter" (written on insert, applied on read and delete)
create table sample_files.picture (
  id           int generated always as identity primary key,
  related_type text not null check (related_type in ('folder', 'person', 'visit')),
  related_id   text not null,
  filename     text not null,
  mime_type    text not null,
  content      bytea not null check (octet_length(content) <= 2 * 1024 * 1024)
);
create index on sample_files.picture (related_type, related_id);
-- a 1x1 picture for folder 1 and one for person 1: the same related_id, each shown only on its own form
insert into sample_files.picture (related_type, related_id, filename, mime_type, content)
select t, '1', f, 'image/png', decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  from (values ('folder', 'alpha-site.png'), ('person', 'ada-desk.png')) as p (t, f);

-- (252) site visits: a page that saves with its own processes, not a form region
create table sample_files.visit (
  id         int generated always as identity primary key,
  visited_on date not null default current_date,
  note       text not null
);
insert into sample_files.visit (visited_on, note) values (date '2026-11-02', 'Roof inspection, north side');

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_files') then create role app_sample_files nologin; end if;
end $$;
grant app_sample_files to pgkiln_runtime;
grant usage on schema sample_files to app_sample_files;
grant select, insert, update, delete on all tables in schema sample_files to app_sample_files;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-files', 'Sample Files', 1, 'app_users', 'app_sample_files');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-files';

insert into meta.page (app_id, page_no, name, title)
select id, 1, 'Sample Files', 'Sample Files' from meta.app where alias = 'sample-files';

-- the Report and form wizard: documents (2, 3), folders (4, 5), people (6, 7)
select meta.generate_page('sample-files', 'report_form', 'sample_files.document', 2, '{"label": "Documents", "form_page": 3, "nav": false}');
select meta.generate_page('sample-files', 'report_form', 'sample_files.folder', 4, '{"label": "Folders", "form_page": 5, "nav": false}');
select meta.generate_page('sample-files', 'report_form', 'sample_files.person', 6, '{"label": "People", "form_page": 7, "nav": false}');
update meta.page set parent_page = 1 where app_id = (select id from meta.app where alias = 'sample-files') and page_no in (2, 4, 6);

-- the reports leave the file contents out
update meta.region set source = 'select id, title, category, filename, file_size, updated from sample_files.document order by title',
       config = config || '{"headings": {"file_size": "Size (bytes)"}}'
 where page_id = pg_temp.page_id('sample-files', 2) and type = 'report';
update meta.region set source = E'select f.id, f.name, f.description, count(a.id) as files\n  from sample_files.folder f left join sample_files.attachment a on a.folder_id = f.id\n group by f.id order by f.name'
 where page_id = pg_temp.page_id('sample-files', 4) and type = 'report';
update meta.region set source = 'select id, name, photo_name from sample_files.person order by name',
       config = config || '{"headings": {"photo_name": "Photo"}}'
 where page_id = pg_temp.page_id('sample-files', 6) and type = 'report';

-- page 3: one file in the document's own columns; its name, type, size and date are kept beside it
delete from meta.item where page_id = pg_temp.page_id('sample-files', 3) and name in ('P3_FILENAME', 'P3_MIME_TYPE', 'P3_FILE_SIZE', 'P3_UPDATED');
update meta.item set type = 'file', label = 'File', help = 'A PDF, a picture, a text or a Word file of at most 5 MB.',
       config = '{"filename_column": "filename", "mime_column": "mime_type", "size_column": "file_size", "updated_column": "updated",
                  "accept": ".pdf,image/*,.txt,.csv,.docx", "max_mb": 5}'
 where page_id = pg_temp.page_id('sample-files', 3) and name = 'P3_CONTENT';
update meta.item set type = 'select', lov = 'STATIC:General,Contract,Invoice,Manual'
 where page_id = pg_temp.page_id('sample-files', 3) and name = 'P3_CATEGORY';

-- page 5: several files per folder, in the child table sample_files.attachment
insert into meta.item (page_id, region_id, seq, name, label, type, source_column, help, config)
select r.page_id, r.id, 100, 'P5_FILES', 'Files', 'file', 'content', 'Up to five files of at most 5 MB each.',
       '{"multiple": true, "max_files": 5, "max_mb": 5, "table": "sample_files.attachment", "parent_column": "folder_id",
         "key_column": "id", "filename_column": "filename", "mime_column": "mime_type", "wide": true}'
  from meta.region r where r.page_id = pg_temp.page_id('sample-files', 5) and r.type = 'form';

-- (MG-20) pages 5 and 7: pictures in the shared table sample_files.picture, shown as a gallery
insert into meta.item (page_id, region_id, seq, name, label, type, source_column, help, config)
select r.page_id, r.id, x.seq, x.name, 'Pictures', 'file', 'content', 'Up to six pictures of at most 2 MB each.',
       jsonb_build_object('multiple', true, 'display', 'gallery', 'max_files', 6, 'max_mb', 2, 'accept', 'image/png,image/jpeg,image/webp',
         'table', 'sample_files.picture', 'parent_column', 'related_id', 'key_column', 'id', 'filename_column', 'filename',
         'mime_column', 'mime_type', 'filter', jsonb_build_object('related_type', x.kind), 'wide', true)
  from meta.region r
  join (values (5, 110, 'P5_PICTURES', 'folder'), (7, 110, 'P7_PICTURES', 'person')) as x (page, seq, name, kind)
    on r.page_id = pg_temp.page_id('sample-files', x.page)
 where r.type = 'form';

-- (252) page 8: site visits, saved by the page's own processes (no form region); the pictures' record key is the
-- protected hidden item P8_ID ("parent_item"), which the Save process fills for a new visit before the files are saved
insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 8, 'Site visits', 'Site visits', 1 from meta.app where alias = 'sample-files';
insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select pg_temp.page_id('sample-files', 8), r.seq, r.title, r.type, 12, r.template, r.source, r.config::jsonb
  from (values
  (5, 'About this page', 'static', 'plain',
   '<p class="lead">This page saves a visit with its own processes instead of a form region. Its <strong>Pictures</strong> name the item that holds the visit''s key, <code>"parent_item": "P8_ID"</code>, a protected hidden item: the gallery lists, removes and serves the pictures of that visit, and saves new ones after the processes, so a new visit''s pictures go in with it.</p>', '{}'),
  (10, 'Visit', 'static', 'standard', null, '{}'),
  (20, 'Visits', 'report', 'standard', 'select id, visited_on, note from sample_files.visit order by visited_on desc, id desc',
   '{"headings": {"visited_on": "Date", "note": "Note"}, "hidden": ["id"], "link": {"column": "note", "page": 8, "items": {"P8_ID": "#id#"}}}')
  ) as r (seq, title, type, template, source, config);
insert into meta.item (page_id, region_id, seq, name, label, type, source_column, help, config)
select r.page_id, r.id, i.seq, i.name, i.label, i.type, i.src, i.help, i.config::jsonb
  from meta.region r, (values
  (10, 'P8_ID', null, 'hidden', null, null, '{}'),
  (20, 'P8_VISITED_ON', 'Date', 'date', null, null, '{}'),
  (30, 'P8_NOTE', 'Note', 'textarea', null, null, '{}'),
  (40, 'P8_PICTURES', 'Pictures', 'file', 'content', 'Up to four pictures of at most 2 MB each.',
   '{"multiple": true, "display": "gallery", "max_files": 4, "max_mb": 2, "accept": "image/png,image/jpeg,image/webp",
     "table": "sample_files.picture", "parent_column": "related_id", "parent_item": "P8_ID", "key_column": "id",
     "filename_column": "filename", "mime_column": "mime_type", "filter": {"related_type": "visit"}, "wide": true}')
  ) as i (seq, name, label, type, src, help, config)
 where r.page_id = pg_temp.page_id('sample-files', 8) and r.title = 'Visit';
update meta.item set required = true where page_id = pg_temp.page_id('sample-files', 8) and name = 'P8_NOTE';
insert into meta.button (page_id, region_id, seq, name, label, hot)
select r.page_id, r.id, b.seq, b.name, b.label, b.hot
  from meta.region r, (values (10, 'SAVE', 'Save', true), (20, 'NEW', 'New visit', false)) as b (seq, name, label, hot)
 where r.page_id = pg_temp.page_id('sample-files', 8) and r.title = 'Visit';
insert into meta.process (page_id, seq, name, type, point, code, when_button)
select pg_temp.page_id('sample-files', 8), p.seq, p.name, 'sql', p.point, p.code, p.button
  from (values
  (10, 'Fetch the visit', 'load', 'select visited_on as p8_visited_on, note as p8_note from sample_files.visit where id = nullif(:P8_ID, '''')::int', null),
  (20, 'Save the visit', 'submit', E'update sample_files.visit set visited_on = coalesce(nullif(:P8_VISITED_ON, '''')::date, visited_on), note = :P8_NOTE\n where id = nullif(:P8_ID, '''')::int;\nwith ins as (\n  insert into sample_files.visit (visited_on, note)\n  select coalesce(nullif(:P8_VISITED_ON, '''')::date, current_date), :P8_NOTE where nullif(:P8_ID, '''') is null\n  returning id)\nselect coalesce((select id from ins)::text, nullif(:P8_ID, '''')) as p8_id', 'SAVE'),
  (30, 'Clear for a new visit', 'submit', 'select null as p8_id, null as p8_visited_on, null as p8_note', 'NEW')
  ) as p (seq, name, point, code, button);

-- page 7: a picture, cropped square in the browser before it is uploaded
delete from meta.item where page_id = pg_temp.page_id('sample-files', 7) and name in ('P7_PHOTO_NAME', 'P7_PHOTO_MIME');
update meta.item set type = 'file', label = 'Photo', help = 'A picture: choose the square part to keep.',
       config = '{"filename_column": "photo_name", "mime_column": "photo_mime", "accept": "image/png,image/jpeg,image/webp", "max_mb": 2,
                  "crop": "1:1", "max_px": 800, "capture": "user"}'
 where page_id = pg_temp.page_id('sample-files', 7) and name = 'P7_PHOTO';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values (10, 'Home', 'home', 1), (20, 'Documents', 'file', 2), (30, 'Folders', 'folder', 4), (40, 'People', 'users', 6)) as n (seq, label, icon, page)
 where a.alias = 'sample-files';

insert into meta.list (app_id, name, type, description)
select id, 'FILE_TOPICS', 'static', 'The pages of Sample Files' from meta.app where alias = 'sample-files';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'FILE_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Documents', 'file', 2, 'A file in the record''s own bytea column, with its name, type, size and date beside it.'),
  (20, 'Folders', 'folder', 4, 'Several files per record in a child table: add some, remove some, all saved with the record.'),
  (30, 'People', 'users', 6, 'A photo cropped square in the browser and made smaller before it is uploaded.'),
  (40, 'Site visits', 'camera', 8, 'A page that saves with its own processes: its pictures name the item holding the record''s key.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-files';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select pg_temp.page_id('sample-files', r.page), r.seq, r.title, r.type, 12, r.template, r.source, r.config::jsonb
  from (values
  (1, 10, 'Sample Files', 'static', 'hero',
   '<p>A file item uploads into a <code>bytea</code> column, or into a child table with a row per file. Choose, drop or paste a file; the server checks its type and size, and the form saves it with the record in one transaction. Download links are bound to the user and the record, the file is read as the application''s role (grants and row level security apply), and it is sent as an attachment, so an uploaded HTML or SVG file never runs in the application.</p>',
   '{"icon": "file"}'),
  (1, 20, 'Topics', 'list', 'plain', null, '{"list": "FILE_TOPICS", "template": "cards"}'),
  (2, 5, 'About this page', 'static', 'plain',
   '<p class="lead">Open a document: the form shows its file with a download link (pictures with a preview) and a <strong>Remove file</strong> box. The file item''s <code>filename_column</code>, <code>mime_column</code>, <code>size_column</code> and <code>updated_column</code> fill those columns on upload; <code>accept</code> and <code>max_mb</code> limit what may be uploaded.</p>', '{}'),
  (4, 5, 'About this page', 'static', 'plain',
   '<p class="lead">Open a folder: <code>"multiple": true</code> with <code>table</code> and <code>parent_column</code> keeps a row per file in <code>sample_files.attachment</code>. The form lists the folder''s files with download links; tick <strong>Remove file</strong> to delete one on save, or add up to five at once. <strong>Pictures</strong> keeps its files in <code>sample_files.picture</code>, a table folders and people share: <code>"filter": {"related_type": "folder"}</code> writes that column on insert and limits what the item reads and deletes, and <code>"display": "gallery"</code> shows them as thumbnails that open the full-size picture.</p>', '{}'),
  (6, 5, 'About this page', 'static', 'plain',
   '<p class="lead">Open a person and choose a photo: with <code>"crop": "1:1"</code> the browser asks which square part to keep, and <code>max_px</code> makes it smaller before the upload. On a phone, <code>capture</code> offers the camera. Its <strong>Pictures</strong> gallery shares <code>sample_files.picture</code> with the folders (<code>"filter": {"related_type": "person"}</code>).</p>', '{}')
  ) as r (page, seq, title, type, template, source, config);
