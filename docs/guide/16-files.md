# 16. Files, data loading and printing

This chapter covers three things that deal with files:

- **file upload items**, where users upload files into a table or a process;
- **data loading**, which loads CSV, Excel, JSON and XML files into tables, from the SQL
  Workshop or from an application page, optionally with a saved data load definition;
- **downloads and printing**: reports as CSV, Excel and PDF (with adjustable report layouts),
  and printing any page from the browser.

| APEX | pgkiln |
|---|---|
| File Browse item, storage "BLOB column specified in item source" | Item type `file` with a bytea `source_column` in a form region |
| File Browse item, storage "Table APEX_APPLICATION_TEMP_FILES" | Item type `file` without a source column; read the file from `meta.temp_files` |
| File Browse item, "Allow Multiple Files" | Item type `file` with `"multiple": true`: one row per file in a child table, or a list of temporary files |
| SQL Workshop → Data Workshop → Load Data | SQL Workshop → **Load Data** |
| SQL Workshop → Data Workshop → Unload Data | SQL Workshop → **Unload Data** |
| SQL Workshop → Data Workshop → Data Generator | SQL Workshop → **Sample Data** |
| Shared Components → Data Load Definitions | Shared Components → **Data load definitions** |
| Data Load Definition + "Execute Data Load" process | Process type `data_load` with `"definition"` |
| Interactive report → Download → CSV / Excel / PDF | Actions → **Download CSV / Excel / PDF** |
| Shared Components → Report Layouts | Shared Components → **Report layouts** |
| Print (browser) | Actions → **Print**, and a print stylesheet on every page |
| Static Application Files (`#APP_FILES#`) | Shared Components → **Static application files** ([chapter 3](03-builder.md#static-application-files)) |
| Static Workspace Files (`#WORKSPACE_FILES#`) | Workspace utilities → **Static workspace files** ([below](#static-workspace-files)) |

## File upload items

A `file` item shows a file input. When the page is submitted, the uploaded file is stored as a
**temporary file of the session**, and the item's value becomes that file's id (a uuid). The
upload is kept when validation fails, so users don't have to choose the file again. Where the
file goes next depends on the item.

### Dropping and pasting files

With JavaScript, every file item is also a **drop zone**: users can drag files from their desktop
onto the field, or **paste** them (APEX 26.1: paste files), for example a screenshot or a file copied
in the file manager. A paste goes to the file item that has focus, or to the page's only file item
when no text field has focus, so pasting text into a text field works as usual. A multiple file
item adds the dropped or pasted files to the ones already chosen; a single file item takes the
first one. The files go into the file input, so they are checked and saved exactly like chosen
files (and photos are made smaller first with `max_px`). A file dropped next to a drop zone doesn't
open in the browser, so the form isn't lost.

### Cropping pictures

With `"crop"` in a single-file item's attributes, a picture the user chooses (or drops, or pastes) opens a **crop
dialog** before it is uploaded: a frame over the picture to drag and resize (with the keyboard: arrow keys move it,
Shift and arrow keys resize it, Alt for single pixels). *Use this part* uploads the cropped picture, *Keep the whole
picture* the original. Values: `"free"`, `"1:1"`, `"4:3"`, `"3:4"`, `"16:9"`, `"3:2"`, `"2:3"` (other values are
ignored). JPEG, PNG and WebP pictures are cropped (a PNG stays a PNG, the others become JPEG); `max_px` then makes
the result smaller. Without JavaScript the picture is uploaded as chosen. HR example: the employee photo (page 3) is
cropped to a square (`hr_45`).

```json
{"accept": "image/*", "crop": "1:1", "max_px": 800}
```

### Signatures

(sprint 239) A **signature** item (`signature`, [chapter 5](05-items.md#signature)) is a file item whose file is drawn:
a pad to sign on with a finger, a pen or the mouse, posted as a PNG (`<item>.png`, at most 1 MB and 4096 px each
way, checked from the bytes). It is stored like any single file below: a `bytea` form column, or `meta.temp_files` in
a process.

### In a table column (form regions)

Give the item a `source_column` of type `bytea` in a [form region](04-pages-and-regions.md#form).
Saving the form writes the file into that column. You can also store its name and MIME type:

```sql
alter table hr.emp add column photo bytea, add column photo_name text, add column photo_mime text;
```

| Attribute (`config`) | Meaning |
|---|---|
| `filename_column` | Column for the file name |
| `mime_column` | Column for the MIME type (as the browser reported it) |
| `accept` | Allowed types, as for the HTML `accept` attribute: `image/png,image/jpeg`, `.csv,.xlsx`, `image/*`. Checked on the server |
| `max_mb` | Largest file in MB (at most `MAX_UPLOAD_MB`, default 10) |

The form then shows the current file, with a download link. Images (PNG, JPEG, GIF, WebP) also
get a preview. The form has a **Remove file** option, and a file input to replace the file.
Saving without choosing a file keeps the stored file. A `required` file item accepts a record
that already has a file.

The form never loads the file into session state. Only its size, name and type are read when the
page is shown.

The HR sample's employee form (page 3) has a photo item set up this way:

```json
{"filename_column": "photo_name", "mime_column": "photo_mime", "accept": "image/png,image/jpeg,image/webp", "max_mb": 2}
```

### In a process (temporary files)

A file item without a form column just holds the temporary file's id. Read the file in a
process through the view **`meta.temp_files`**, which shows only the current session's files
(like `APEX_APPLICATION_TEMP_FILES`):

```sql
insert into hr.document (empno, name, mime_type, content)
select :P5_EMPNO::int, filename, mime_type, content
  from meta.temp_files
 where id = :P5_FILE::uuid;

select meta.delete_temp_file(:P5_FILE::uuid);  -- optional: it is removed with the session anyway
```

Temporary files are deleted with the session, at sign-out or when the session expires. A
session keeps at most 20 of them.

### Several files per item

With `"multiple": true` the file input lets users choose several files at once (APEX: *Allow
Multiple Files*). Each file is checked against `accept` and `max_mb`. If one file is refused, none
of that request's files are kept. The item's value is the ids of its new temporary files,
separated by `:`.

**In a form region** the files go into a **child table**, one row per file, linked to the form's
record. The item's `source_column` is the child table's content column:

```sql
create table hr.emp_document (
  id        bigint generated always as identity primary key,
  empno     int   not null references hr.emp on delete cascade,
  filename  text  not null,
  mime_type text  not null,
  content   bytea not null
);
```

| Attribute (`config`) | Meaning |
|---|---|
| `multiple` | `true`: several files per item |
| `max_files` | Most files the item may hold, the stored ones included (default and at most 10) |
| `table` | The child table |
| `parent_column` | Its column that holds the form record's primary key |
| `key_column` | Its primary key (default `id`) |
| `filename_column`, `mime_column`, `accept`, `max_mb` | As for a single file |
| `filter` | Constant columns of a child table shared by several record types, `{"related_type": "folder"}`: [below](#a-child-table-shared-by-several-record-types) |
| `display` | `"gallery"`: the files as a [picture gallery](#picture-gallery) instead of a list |
| `parent_item` | Outside a form region: the protected hidden item holding the record's key, [below](#outside-a-form-region-parent-item) |

The form lists the record's files with download links (and a small preview for images), followed
by the files that will be added on save. Every file has a **Remove file** box. Saving the form
inserts a row per new file and deletes the ticked rows, in the same transaction as the record
itself. A ticked new file is dropped at once. Deleting the record deletes its files first.
`required` means at least one file. The HR sample's employee form has a **Documents** item set up
this way (`examples/hr/hr_16_documents.sql`), with row level security on `hr.emp_document`:

```json
{"multiple": true, "max_files": 5, "max_mb": 5, "table": "hr.emp_document", "parent_column": "empno",
 "key_column": "id", "filename_column": "filename", "mime_column": "mime_type", "accept": ".pdf,.docx,image/*"}
```

#### A child table shared by several record types

Some schemas keep the files of several kinds of record in one table, with a column naming the kind
and one holding the record's id, and no foreign key:

```sql
create table sample_files.picture (
  id           int generated always as identity primary key,
  related_type text not null check (related_type in ('folder', 'person')),
  related_id   text not null,
  filename     text not null,
  mime_type    text not null,
  content      bytea not null
);
create index on sample_files.picture (related_type, related_id);
```

`filter` names the columns that pick out this item's rows, with their values. They are **written on
insert** and **added to every read, delete and download** of the item, next to `parent_column`, so
the folder form only lists, removes and serves folder pictures, even when a person has the same id;
deleting a folder deletes its own pictures and leaves the people's alone:

```json
{"multiple": true, "table": "sample_files.picture", "parent_column": "related_id", "key_column": "id",
 "filename_column": "filename", "mime_column": "mime_type", "filter": {"related_type": "folder"}}
```

- Values are texts, numbers or booleans; `null` (or an empty text) means *is null*. Each value is
  passed as a quoted literal, so PostgreSQL reads it as the column's type.
- A value may contain `&NAME.` substitutions of `APP_USER`, `APP_ID`, `APP_ALIAS`, `APP_PAGE_ID`,
  `APP_LANGUAGE` or a **protected hidden item** of the page (`{"related_type": "&P5_KIND."}`), values a
  request can't set. Any other item is refused with an error: a field the user can post would let a
  forged request widen the filter to other rows.
- The filter comes from the item's attributes only: nothing posted changes it.
- `parent_column` may have another type than the record's key: a `text` `related_id` holds an
  integer `id` (the key is passed as an untyped literal and read as the column's type).
- A shared table has no foreign key to cascade deletes or check ids: the item deletes the record's
  rows itself when the form deletes the record. Rows that other code writes keep their own values.
  Give the table row level security as for any child table.

#### Outside a form region: `parent_item`

(sprint 252) A page that saves its record with its own processes (a static region, SQL that inserts or
updates, fields kept in a `jsonb` column) has no form region for the item to follow. Name the item
that holds the record's key instead, with `parent_item`:

```json
{"multiple": true, "display": "gallery", "table": "sample_files.picture", "parent_column": "related_id",
 "parent_item": "P8_ID", "key_column": "id", "filename_column": "filename", "mime_column": "mime_type",
 "filter": {"related_type": "visit"}}
```

- The item lists, removes and serves the files of the record whose key is in `P8_ID`, as in a form.
- It saves new files and removes ticked ones **after the page's submit processes**, in the same
  transaction, so a process that inserts a new record and returns its key (`select id as p8_id`)
  gets the files with it. Without a key the new files stay pending.
- `parent_item` must be a **protected hidden item** of the page, a value a request can't set: a forged
  post can't point the item at another record. Any other item is refused with an error.
- The item has a source column (`content` above), as in a form region.
- Deleting the record is the page's own work: its process deletes the rows (or a foreign key cascades).

Sample Files (App Gallery) page 8, *Site visits*, saves with its own processes and keeps its pictures
in the shared `sample_files.picture`.

#### Picture gallery

With `"display": "gallery"` the item shows its files as a grid of square **thumbnails** (two per
row on a phone, more on wider screens). A picture (PNG, JPEG, GIF or WebP) links to the **full-size
picture**, opened in a new tab; any other file shows a file icon. Each tile has the file name as a
download link, its size and the **Remove file** box; new files are marked *new* until the form is
saved. Read-only, the gallery has no boxes. Everything else (limits, saving, removal) works as for a
list. Sample Files (App Gallery) shows a gallery on its folder and person forms, both on
`sample_files.picture`:

```json
{"multiple": true, "display": "gallery", "max_files": 6, "max_mb": 2, "accept": "image/png,image/jpeg,image/webp",
 "table": "sample_files.picture", "parent_column": "related_id", "key_column": "id",
 "filename_column": "filename", "mime_column": "mime_type", "filter": {"related_type": "person"}}
```

**Without a child table** the files stay temporary, as with a single file. Read them in a process:

```sql
insert into doc.attachment (ticket_id, name, mime_type, content)
select :P5_TICKET_ID::int, filename, mime_type, content
  from meta.temp_files
 where id = any (string_to_array(:P5_FILES, ':')::uuid[]);
```

A session keeps at most 20 temporary files, so keep `max_files` at 10 or less (the server caps
it at 10) and save the files before users upload many more.

### Object storage

APEX 26.1 stores File Browse items in object storage as well. In pgkiln a single or multiple file
item keeps its files in an **S3-compatible bucket** (Amazon S3, MinIO, Cloudflare R2, Wasabi,
Backblaze B2, OCI's S3 compatibility API, …), or in [OneDrive or SharePoint](#onedrive-and-sharepoint), with
`object_store` in its attributes:

```json
{"object_store": {"url": "https://s3.eu-west-1.amazonaws.com/hr-files", "credential": "S3_HR", "prefix": "photos/"},
 "filename_column": "photo_name", "mime_column": "photo_mime", "size_column": "photo_size"}
```

- `url`: the bucket's URL, path style (`https://s3.<region>.amazonaws.com/<bucket>`,
  `http://minio:9000/<bucket>`) or virtual-host style (`https://<bucket>.s3.<region>.amazonaws.com`).
  Its host must be on the server's allow-list (`PGKILN_REST_ALLOWED_HOSTS`, and
  `PGKILN_REST_PRIVATE_HOSTS` for a store on your own network), like every call pgkiln makes
  ([chapter 19](19-rest-data-sources.md#server-configuration-and-the-allow-list)).
- `credential`: a [web credential](19-rest-data-sources.md#web-credentials) of type `aws_sigv4`
  (access key id, secret access key, region); requests are signed with AWS Signature Version 4.
  Its *Valid for* URLs should name the bucket.
- `prefix`: keys start with it; each file gets `<prefix><random id>/<file name>`. It may hold `&ITEM.` substitutions: a
  [folder per record](#a-folder-per-record). A key outside the prefix (or with a `.` or `..` segment) is refused
  for every download and delete, so a key written into the table some other way can't reach the rest of the bucket.
- The item's **source column holds the object's key** (a `text` column) instead of the bytes;
  `size_column` (optional) the size, which the form shows. Name and type columns work as before.
  For a multiple item the child table's rows hold the keys.

Uploads stay temporary files of the session until the form is saved; then the file goes to the
bucket and its key into the row. A file that is replaced or removed, or whose record is deleted, is
deleted from the bucket **after the save committed**; when the save fails, the file just stored is
deleted again, so the bucket follows the table. Downloads go through pgkiln as before: the row is
read as the application's role (RLS applies), the link carries the user's checksum, and the
content is fetched from the bucket and sent with the same headers. Users never see the bucket's
address or the credential. Downloads are limited to `MAX_UPLOAD_MB`.

#### OneDrive and SharePoint

Since sprint 244 a file item can keep its files in **OneDrive or a SharePoint document library** instead, through
Microsoft Graph, so they stay where the office opens and edits them. Set `"provider": "graph"` in `object_store`:

```json
{"object_store": {"provider": "graph", "drive": "b!3x…Qz", "folder": "HR/Policies", "credential": "MS_GRAPH"},
 "filename_column": "file_name", "mime_column": "file_mime", "size_column": "file_size"}
```

| Key | Means |
|---|---|
| `drive` | The drive id: a user's OneDrive or a document library (`/drives/{drive}`); (sprint 253) `"me"`: the OneDrive of the user a delegated credential belongs to (`/me/drive`) |
| `site` | Instead of `drive`: a SharePoint site id (`contoso.sharepoint.com,<site guid>,<web guid>`); its default document library (`/sites/{site}/drive`) |
| `folder` | The folder in the drive, e.g. `HR/Policies` (default: the drive's root). Graph creates it on the first upload. (sprint 253) May hold `&ITEM.` substitutions: a [folder per record](#a-folder-per-record) |
| `credential` | A [web credential](19-rest-data-sources.md#web-credentials) of type OAuth2 (or bearer token) |
| `url` | The Graph base URL; default `https://graph.microsoft.com/v1.0` (a national cloud: `https://graph.microsoft.us/v1.0`, …) |

- **The credential.** App-only: an OAuth2 credential with grant *client credentials*, token URL
  `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`, the
  client id and secret of an Entra ID application with the *application* permission `Files.ReadWrite.All`, or
  `Sites.Selected` granted to just the one site (the narrower choice). Delegated: grant *authorization code*, scope
  `Files.ReadWrite.All offline_access`, authorized once by a developer in the builder; the files are then written
  as that user. Its *Valid for* URLs should be `https://graph.microsoft.com/`.
- **The allow-list.** Graph, the token endpoint, and the hosts Graph hands out for upload sessions and downloads:
  `PGKILN_REST_ALLOWED_HOSTS=graph.microsoft.com,login.microsoftonline.com,*.sharepoint.com` (add
  `*.files.1drv.com` and `*.sharepoint-df.com` if a tenant uses them).
- **Uploads.** A file of at most 4 MB is PUT in one request to `…/root:/<folder>/<name>:/content`; a larger one goes
  through an **upload session** (`createUploadSession`, then ranges of 3.2 MB PUT to the session's URL, which is
  pre-authenticated: the credential is not sent there). The name is made safe (letters, digits, `_ . -`; never a
  path); a name in use gets a number (`contract 1.pdf`). A file is at most `MAX_UPLOAD_MB` and
  `PGKILN_REST_MAX_UPLOAD_BYTES` (default 25 MB).
- **The source column holds the drive item's id**, so a file the office renames, or moves to a subfolder, is still
  found. Before a download or a delete pgkiln checks that the item lies in the configured folder (or below it): an id
  written into the table some other way can't reach the rest of the drive.
- **Downloads go through pgkiln**, with the same checks as S3: page access, the row read as the application's
  role (RLS), the link's checksum. Graph answers with a redirect to a short-lived download URL; the server follows
  it (without the credential) and sends the file. Users never get a Graph or SharePoint link, a sharing link is
  never made, and the token never leaves the server.
- **Replace, remove, delete** work as for S3: the old file is deleted from the library after the save committed;
  when the save fails, the file just uploaded is deleted again.

HR example (part 108, page 77 *Policy documents*): policy documents in the SharePoint folder `HR/Policies` with the
credential `MS_GRAPH`; the part's header lists the set-up steps. Until the credential has a secret, an upload is
refused and nothing is saved.

#### A folder per record

(sprint 253) `folder` (OneDrive / SharePoint) and `prefix` (S3) may hold `&ITEM.` substitutions, filled in from the
session state **at upload time**, so each record's files get a folder of their own:

```json
{"object_store": {"provider": "graph", "drive": "b!3x…Qz", "folder": "Sales/Orders/&P3_ORDER_NO./Photos", "credential": "MS_GRAPH"}}
{"object_store": {"url": "https://s3.eu-west-1.amazonaws.com/sales", "credential": "S3_SALES", "prefix": "orders/&P3_ORDER_NO./"}}
```

- Each value becomes (part of) **one path segment**: `/`, `\`, control characters, characters the store does not
  take and runs of dots become `_`; an empty (or unknown) value becomes `_`. A value can never add a level or climb
  out of the folder.
- Downloads, deletes and [stored files in documents and mails](#stored-files-in-documents-and-mails) accept a file
  anywhere **below the static part**: the folder up to the last `/` before the first substitution (`Sales/Orders/`
  above). A file of any record's subfolder is reachable, nothing outside the base.
- Use an item that has its value when the form is saved: on a new record the key item (`P3_ID`) is usually still
  empty, because the database assigns it during the insert; a number the user enters, or one a computation sets
  before the save, works. The folder is fixed when the file is uploaded: a later change of the value doesn't move it.

HR example (part 114): page 77's files go to `HR/Policies/&P77_TITLE.`.

#### Stored files in documents and mails

(sprint 253) A file kept in object storage has no bytes in the database, so SQL can't hand it to a PDF or a mail
the way it hands over a `bytea`. Two references let the server fetch it instead:

- **In a [document template](#document-templates):** `<img src="stored:ITEM:key">`. `ITEM` is a file item of the
  same application with `object_store`; `key` the value its source column holds (an S3 key, a drive item id),
  usually a column of the template's query: `<img src="stored:P3_PHOTO:{{photo_key}}" width="60mm">`. The server
  fetches the file while it draws the PDF. PNG and JPEG only, at most `MAX_UPLOAD_MB`, the same `width` rules as a
  `data:` image. A file that is missing, not a PNG/JPEG, outside the store or refused is **left out** (and logged
  on the server): the rest of the PDF is still drawn.
- **In a mail:** `meta.add_mail_attachment_stored(p_mail, p_item, p_key, p_filename, p_mime)` adds an attachment by
  reference to a mail queued in the same transaction ([chapter 6](06-processing.md#sending-e-mail)). The mail sender
  fetches the file when it sends the mail; a fetch that fails (Graph or the bucket not reachable) is retried like
  any failed attempt, a file that is not there fails the mail. The limits of `meta.add_mail_attachment` apply (20
  attachments, 10 MB each, 20 MB per mail).

```sql
-- a process of the order page: mail the order's photos
select meta.add_mail_attachment_stored(m.id, 'P3_PHOTO', p.photo_key, p.photo_name, p.photo_mime)
  from (select meta.send_mail(:P3_EMAIL, 'Your order', 'The photos are attached.') as id) m,
       sales.order_photo p
 where p.order_id = :P3_ID::int
```

**Security.** The item must be a file item of the application that runs the SQL, with an object store (an item of
another application, or one that keeps its files in the database, is refused); the key must lie in that store,
as for a download: below the S3 prefix's static part, or in the OneDrive / SharePoint folder (its static part) or
below it. *Which* keys a user reaches is up to the template's query and the process's SQL, which run as the
application's role: row level security on the table that holds the keys decides.

HR example (part 114): page 77 has *Print* (the template `POLICY_SHEET` shows the file when it is a picture) and
*Mail to me* (the file attached by reference).

**Recipe: try it without Microsoft 365.** The tests run against a small Graph stub (`test/graph-stub.ts`: a token
endpoint, simple uploads, upload sessions, item metadata, downloads by redirect, deletes). To try a page by hand,
start it from a small script
(`const stub = await startGraphStub(); console.log(stub.url, stub.tokenUrl)`, run with `npx tsx`), set the item's
`"url"` to `stub.url`, give the OAuth2 credential the token URL `stub.tokenUrl`, client id `stub-client-id` and
secret `stub-client-secret-do-not-leak`, and allow `127.0.0.1` in `PGKILN_REST_PRIVATE_HOSTS`. Against the real
Graph, Graph Explorer finds a library's drive id: `GET /sites/{host}:/sites/{name}` gives the site id,
`GET /sites/{site id}/drives` its libraries.

### Downloads and security

- **Download links** carry a checksum bound to the user, the page, the item and the record. A
  link doesn't work for another user or another record. The download also checks page access.
- **The file is read as the application's database role**, so grants and row level security
  apply. A row the user may not see gives *not found*.
- **Files are sent as attachments** (`Content-Disposition: attachment`) with
  `X-Content-Type-Options: nosniff` and a sandboxing Content Security Policy. Only PNG, JPEG,
  GIF, WebP and PDF are shown inline (image previews). An uploaded HTML or SVG file can never run
  in your application's origin.
- **A posted text value can't set a file item.** Only an upload can, and `meta.temp_files` only
  shows the session's own files. A **Remove file** box only removes rows of the form's own record
  (and of the session's own temporary files), whatever value it posts.
- **Audit trails:** keep file contents out of JSON audit logs. The HR sample's `hr.audit()`
  takes a list of columns to leave out: `hr.audit('empno', 'photo')`.

Large files in bytea columns are fine up to tens of megabytes. For bigger files or large numbers
of them, store them in object storage and keep the key in the table.

## Static workspace files

Files a developer ships with the applications, rather than files users upload: CSS, JavaScript, JSON, images, fonts
and PDFs. An application has its own (Shared Components → **Static application files**,
[chapter 3](03-builder.md#static-application-files)); since sprint 141 a **workspace** has them too (Workspace
utilities → **Static workspace files**; APEX: Static Workspace Files), shared by every application of the workspace,
for example one stylesheet with the company's colours.

| Write | Means |
|---|---|
| `#WORKSPACE_FILES#brand.css` in *Every page loads* (or a page's *JavaScript and CSS files*) | Every page (that page) loads the workspace's `brand.css` with `<link>` (a `.js` file with `<script src defer>`), after pgkiln's own, in list order with the application's own files |
| `#WORKSPACE_FILES#logo.png` in HTML, a template, a list entry, a link | `/a/<alias>/workspace-files/logo.png` |
| `#APP_FILES#guide.pdf` | `/a/<alias>/static/guide.pdf`, the application's own file |

Each application serves the workspace's files from its own address, `/a/<alias>/workspace-files/<name>`, to anyone
(don't put secrets in them): only its own workspace's files, never another workspace's. Pages link to
`…?v=<version>`, which browsers keep for a year; a change gives a new version.

The rules are those of static application files: names of letters, digits, `_`, `-` and `.` with an extension from a
fixed list; **no HTML** (the database refuses it too); up to 5 MB a file; `X-Content-Type-Options: nosniff`; an SVG or
PDF opened on its own is sandboxed, so a script in it never runs. The workspace's administrators upload, write, rename
and delete them; its developers see the list (with the applications and pages that load each file) and open a file in
a sandboxed preview. They travel with the [workspace export](03-builder.md#export-and-import), not with an
application's.

HR example (part 76): `brand.css` is a workspace file; HR loads it as `#WORKSPACE_FILES#brand.css`.

## Data loading

Both ways of loading accept:

- CSV and TSV: UTF-8 with or without BOM, or Windows-1252. The delimiter `,` `;` tab or `|` is
  detected. Quoted fields can contain delimiters, `""` and line breaks.
- Excel `.xlsx`: the first sheet. Numbers keep their exact text and dates become `YYYY-MM-DD`.
- JSON: an array of objects (`[{"empno": 7839, "ename": "KING"}, …]`), an object holding one
  such array (`{"employees": [...]}`), or JSON Lines (one object per line). The keys are the
  columns, in the order they first appear; nested objects and arrays load as JSON text, so they
  fit `json`/`jsonb` columns.
- XML: one row per **repeating element**. Name it (`employee`, or a path such as
  `employees/employee`), or leave it empty and pgkiln takes the element that occurs most often
  among the elements with children or attributes. The columns are the row element's attributes
  (`@empno`), its child elements (`ename`) and deeper elements by path (`address/city`,
  `address/@type`); a row element holding only text is one column. Namespace prefixes are
  dropped. CDATA, character references and the five predefined entities are read. **Document
  type declarations (`<!DOCTYPE …>`) and entity declarations are refused**, so no external
  entities are fetched and no entity expansion ("billion laughs") is possible; nesting is limited
  to 100 levels. The reader is pgkiln's own (`src/xml.ts`), not a library.

For CSV and Excel, the first row holds the column names (untick it when it doesn't). The format
is detected from the file name and its first bytes. Empty cells become NULL. Rows are inserted in batches; if
a batch fails, its rows are retried one by one to find the bad rows. **When a row fails, nothing
is loaded**, and you get a list of the failed rows with their errors. To load the good rows and
skip the others instead, tick *Skip rows with errors* (or use `skip_errors` in a process).

To read CSV or JSON in your own SQL instead (a preview, a staging step, a file from a web
service), use [`meta.parse_data()`](09-reference.md#parsing-files-in-sql): the same rules, the
rows as a table function (APEX_DATA_PARSER). It doesn't read Excel or XML.

### SQL Workshop → Load Data

(To start a new application from a spreadsheet, with the table, its rows and the pages, use
**Create → From a file**: [chapter 3](03-builder.md#creating-an-application-from-a-file). It uses the same
parsing, type inference and limits.)

1. Choose a file (up to `DATA_LOAD_MAX_MB`, default 50 MB, and `DATA_LOAD_MAX_ROWS` rows). For
   XML you can name the row element. To load with a [data load
   definition](#data-load-definitions), choose it here: the next step previews the file after its
   mapping and transformations and loads it into the definition's table with its mode.
2. Check the preview, then choose where the data goes:
   - **New table:** pgkiln suggests column names (`Hire Date` → `hire_date`) and types from the
     data: `integer`, `bigint`, `numeric`, `boolean`, `date` or `timestamp` (ISO dates only), or
     otherwise `text`. You can change them, or empty a name to skip a column. The table gets an
     identity primary key `id`.
   - **Existing table:** choose the table, then map file columns to table columns. Columns are
     matched by name, ignoring case, spaces and `_`. Then choose a mode:

     | Mode | Effect |
     |---|---|
     | Append | Insert every row |
     | Merge | Update rows with the same primary key and insert the others (`insert … on conflict do update`); the key columns must be mapped |
     | Replace | Delete all rows first (`delete`, so triggers and foreign keys apply), then insert |
     Under **Save this mapping as a data load definition**, the mapping, mode and file format are
     saved as a definition of an application, to load files like this one again or from a page.
3. The result shows the rows inserted, updated and skipped, with a link to the table in the
   Object Browser.

Load Data runs as the workspace's developer login, like the SQL Worksheet (sprint 185; see chapter 3, *Who the SQL Workshop runs as*).

### SQL Workshop → Unload Data

The other direction: download data as a file.

1. Choose the source. **Table or view**: pick one (the list holds the tables, views and
   materialized views of every schema, as in the Object Browser), then tick the columns and
   optionally type a condition (*Where*, without the word `where`) and a sort (*Order by*).
   **Query**: type one `select` (or `with … select`, `values`, `table`) statement.
2. Choose the format and download:

   | Format | Output |
   |---|---|
   | CSV | Separator comma, semicolon, tab or pipe; enclosed by double or single quotes (only values that contain the separator, the enclosure or a line break are enclosed); optional heading row and UTF-8 byte order mark (Excel then reads UTF-8). Text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, like report downloads, so a spreadsheet doesn't run it as a formula |
   | JSON | An array of objects, one per row (`[{"id":1,"name":"…"}, …]`). Numbers stay exact JSON numbers (a `bigint` or `numeric` isn't rounded), `json`/`jsonb` columns are embedded as JSON, booleans are `true`/`false`, null is `null`, everything else a string |
   | Excel (.xlsx) | One sheet with a frozen, filtered heading row; numbers, booleans, dates and timestamps keep their type; text is never a formula (at most 1,048,575 rows) |
   | XML | `<ROWSET><ROW><ID>1</ID>…</ROW></ROWSET>`: the root and row element names can be changed (letters, digits, `_ . -`). One child element per column, named after it (other characters become `_`); null values are left out; text is escaped |

Values are written as Postgres prints them (dates `2026-10-05`, timestamps with their time zone,
`bytea` as `\x…`), not as a page would format them. The rows come from a cursor
(`declare … fetch`) in batches of 1,000 and each batch is sent before the next is read, so memory
stays flat for any table, up to `DOWNLOAD_MAX_ROWS` rows (default 1,000,000).

Unload Data runs as the workspace's developer login (any table it can read), on a connection
of its own in a **read-only transaction**: a statement other than one SELECT is refused, and a
data-modifying `with`, `select … into` or a function that writes fails. Each statement has a
timeout (`UNLOAD_STATEMENT_TIMEOUT`, default `5min`). A failing query shows its error on the form;
an error after the first rows (e.g. the timeout) ends the file early. Every unload is recorded in
the activity log (event `sql_unload`, with the format and the statement).

### SQL Workshop → Sample Data

Rows to develop and test with (APEX 26.1's Data Generator / "sample data for development"):
**SQL Workshop → Sample Data**.

1. Choose a **schema** (`meta`, `information_schema` and `pg_*` are not offered), then tick one or
   more of its **tables**: *Propose generators*.
2. The form has, per table, the number of **rows**, and per column a **generator**, its
   **options** and a percentage of **nulls**. Each column shows its type and the constraints that
   matter (not null, unique, the foreign key, the default, a CHECK range). The proposal follows the
   catalog first and the column name second:

   | Column | Proposed |
   |---|---|
   | identity, `serial`, generated | *Skip*: the database fills it in (`GENERATED ALWAYS` and generated columns can only be skipped) |
   | a foreign key | *Foreign key*: a random existing parent row (all columns of a composite key together) |
   | an enum, or `CHECK (col in (…))` | *Value from a list* with those values |
   | `CHECK (end_date >= start_date)` | `start_date + 0..14` (a date, timestamp or number relative to an earlier column) |
   | a unique whole number | *Sequence* from the current maximum + 1 |
   | numbers | a range inside the CHECK bounds and the column's precision (`price`, `salary` … 10..10000; `lat`/`lng`; `rating` 1..5; `age` 18..80) |
   | dates, timestamps | the last five (two) years; `birth_date` 18 to 70 years ago |
   | text by name | `first_name`, `last_name`, `name`/`full_name`, `email`, `username`/`created_by`, `phone`, `company`/`customer`, `job`, `city`/`location`, `country`, `address`, `postal_code`, `url`, `status`, `code`, `description`/`note` (a sentence), `title`/`…name` (words), otherwise a word |
   | `json`/`jsonb`, other types | a fixed value (`{}`) when the column is NOT NULL without a default, otherwise skipped |

   Generators and their options: first, last and full names, e-mail addresses (on the reserved
   `example.com/org/net` domains, matching the names of the row), user names, phone numbers,
   companies, job titles, street addresses, postal codes, cities, countries, a word, words
   (`1..3`, capitalised), a sentence (`4..12` words), a code (pattern: `A` letter, `a` lower-case
   letter, `9` digit, e.g. `AAA-9999`), web addresses, UUIDs, whole and decimal numbers
   (`min..max`), dates and timestamps (`2021-01-01..2026-12-31`), times (`08:00..18:00`),
   booleans (`50` = % true), a value from a list (`NEW, OPEN, CLOSED`; repeat a value to make it
   likelier), a sequence (`1000` or `1000, 10`), a foreign key and a fixed value. Dates, timestamps
   and numbers also take `column + min..max` (days for dates and timestamps). Text is cut to a
   `varchar(n)` length. The word and name lists are built in (`src/sampledata-words.ts`).
3. **Seed**: the same seed gives the same rows for the same definition and parent rows; every
   column has a random stream of its own, so changing one column doesn't change the others. Empty:
   a new seed per run, which the form then shows.
4. The buttons:

   | Button | Does |
   |---|---|
   | Preview | Inserts the rows and **rolls back**: shows the first 10 rows of each table as stored (identity values, defaults and trigger changes included), or the database's error. The seed is filled in, so *Insert* then adds the same values |
   | Insert rows | The same in **one transaction**, committed: parent tables first (foreign keys between the chosen tables decide the order), so children refer to the existing and the new parent rows. Any error (a constraint, a trigger, the timeout) rolls back every table, and is shown |
   | Download SQL | `begin; insert … values …; commit;` (100 rows per statement), identifiers quoted, values as literals |
   | Download CSV | One table: a `.csv`; several: a `.zip` with one CSV per table (heading row, UTF-8 byte order mark, text formula-guarded as in Unload Data) |

   Unique columns get values not used yet (in the table and the run): another draw, then a number
   appended (e-mail addresses, names, codes); a list or range that runs out stops with a message.
   For downloads, foreign keys pick existing parent rows and the generated rows of parents whose
   key columns are generated too; a key from an identity column is only known after inserting, so
   insert the parents first or use *Insert rows*. A NOT NULL foreign key to an empty parent
   explains which table to generate first.
5. **Save the definition** under a name to open and rerun it later (the list on the start page).
   Definitions are shared by the developers of the installation, like SQL scripts, and not part of
   an application export (they describe tables, not an application).

Sample Data runs as the workspace's developer login (like the SQL Worksheet: triggers run, row level
security applies unless the login owns the table), on a connection of its own that is closed afterwards, with a
statement timeout (`SAMPLE_DATA_STATEMENT_TIMEOUT`, default `5min`) and at most
`SAMPLE_DATA_MAX_ROWS` rows per run (default 100,000). Table and column names come from the
catalog and are always quoted; values are bound parameters. Every insert is recorded in the
activity log (event `sample_data`, with the schema, the seed and the rows per table). The HR example
has a saved generator, *HR demo staff* (departments, employees and leave requests).

### Data load definitions

**Shared Components → Data load definitions** keeps how a kind of file is loaded, by name:

| Property | Meaning |
|---|---|
| Name | Upper case, e.g. `EMP_XML`; a `data_load` process names it |
| Table | `schema.table` |
| Mode | `append`, `merge` (by primary key) or `replace` |
| Skip rows with errors | Load the good rows and report the others (otherwise nothing is loaded) |
| File format | `auto` (detected), `csv`, `xlsx`, `json` or `xml` |
| Headers | CSV / Excel: the first row holds the column names |
| XML row element | e.g. `employee` or `employees/employee`; empty: detected |
| Columns | The mapping as a JSON array; empty: file columns match table columns by name |

Each entry of **Columns** fills one table column:

```json
[
  {"source": "@empno", "column": "empno"},
  {"source": "Full name", "column": "ename", "transform": ["collapse_spaces", "upper"]},
  {"source": "hired", "column": "hiredate", "format": "DD.MM.YYYY"},
  {"source": "salary", "column": "sal", "format": "99999D99", "default": "0"},
  {"column": "status", "default": "NEW"}
]
```

- `source`: the file column: the heading (CSV, Excel), the key (JSON), or the element path or
  `@attribute` (XML). It is matched exactly, then ignoring case, spaces and punctuation.
  Without a source, `default` is loaded into every row as a constant.
- `transform`: applied in order: `trim`, `upper`, `lower`, `initcap`, `collapse_spaces`,
  `digits_only`.
- `format`: a PostgreSQL format mask for `to_date` (date columns), `to_timestamp` (timestamp
  columns) or `to_number` (number columns). `G` and `D` in a number mask follow the database's
  `lc_numeric`; write `,` and `.` to be explicit.
- `default`: used when the value is empty.

The mapping is checked when the definition is saved (unknown keys and transformations, a
column mapped twice). The definition page has **Load a file with this definition**. Definitions
are exported and imported with the application (section `data_load_definitions`).

The HR sample has `EMP_XML`, for XML files like `/static/samples/employees.xml`.

### Data loading in an application

For end users, add a page with a `file` item and a button, and a **process of type
`data_load`** ((sprint 137) **Create page → Data loading** makes the definition and such a page for a table). The process runs **as the application's database role**, so grants, row level
security, triggers and the audit trail apply, just as they do for the form.

| `config` key | Meaning |
|---|---|
| `file_item` | The file item (required) |
| `definition` | A [data load definition](#data-load-definitions) of the application: table, format, mode and mapping come from it, and the keys below are ignored |
| `table` | Target table (required without a definition) |
| `mode` | `append` (default), `merge` or `replace` |
| `skip_errors` | `true`: load the good rows and list the skipped ones |
| `headers` | `false` when the file has no heading row (then use `columns` with `column_1`, `column_2`, …) |
| `columns` | Mapping `{"Heading in the file": "column"}`; without it, columns are matched by name |
| `format` | `auto` (default), `csv`, `xlsx`, `json` or `xml` |
| `row_tag` | XML: the repeating row element (default: detected) |

The success message may use `{inserted}`, `{updated}` and `{failed}`, for example
`{inserted} employees added, {updated} updated.`. Row errors appear on the file item, one entry
per failed row. Values that don't fit (for example `invalid input syntax for type date`) and
`RAISE EXCEPTION` messages from triggers are shown as they are. Other database errors are shown
as a reference to the activity log, as on any page.

The HR sample's page 13, **Administration → Import employees**, merges files into `hr.emp` by
`empno`:

```json
{"file_item": "P13_FILE", "table": "hr.emp", "mode": "merge"}
```

Try it with `/static/samples/employees.csv` or `/static/samples/employees.xml`. A salary above
the president's is refused by the database trigger, and then nothing is loaded. With a
definition instead:

```json
{"file_item": "P13_FILE", "definition": "EMP_XML"}
```

The definition is looked up in the page's own application only, and the load runs as the
application's role like any other `data_load` process.

## Downloads and printing

### Report CSV and Excel

Every interactive report has **Actions → Download CSV** and **Download Excel**. Both contain the
rows of the report as on screen: the same query, search, filters, facets and sort, the same
headings and hidden columns, and the same access checks (page authorization, region visibility,
row level security). They hold at most `DOWNLOAD_MAX_ROWS` rows (default 1,000,000) or the
report's `max_rows`. Both are **streamed**: the query runs as a database cursor and each batch of
1,000 rows is sent before the next is read, so the server's memory stays flat whatever the size.
The query and its first rows run before anything is sent, so a failing query still shows an error.

The Excel file (`.xlsx`) keeps the data types: numbers are numbers, dates and timestamps are
Excel dates, and booleans are TRUE/FALSE. The heading row is bold and frozen, with an
autofilter. Text is always stored as text, so a value like `=HYPERLINK(...)` is never run as a
formula. In the CSV file such values get a leading `'` for the same reason.

Both formats also load back in: see [data loading](#data-loading).

### Report PDF

**Actions → Download PDF** contains:

- **the same rows as the report**, with the same access checks as above;
- a title block: the report title, a header line (by default the application, the time and the
  user) and the active filters;
- the column headings, repeated on every page. Numbers are right-aligned and long values wrap.
  Dates use the application's date format, and booleans the user's language;
- a footer with *page n of m* on every page.

By default the page is A4, portrait, or landscape when the columns don't fit. A PDF holds at
most `PDF_MAX_ROWS` rows (default 5000, up to 100,000; or the report's `max_rows` when lower); if
there are more, a note after the table says so. The rows are read from a cursor in batches of 500
and drawn as they arrive, so the server never holds all query rows at once; the finished PDF itself
is still built in memory before it is sent, because the footer's *page n of m* needs the page
count. The CSV and Excel downloads hold far more (see above) and stream all the way.

### Report layouts

A **report layout** (Shared Components → **Report layouts**) sets how reports print:

| Setting | |
|---|---|
| Paper size | A4, A3, A5, Letter or Legal |
| Orientation | auto (landscape when the columns don't fit), portrait or landscape |
| Font size, margins | in points and millimetres |
| Stretch to the page width | widen the columns so the table fills the page |
| Title, header, footer | texts with substitutions (below); the header may have several lines |
| Show filters | print the search and filters the user applied, or leave them out |
| Colors | column heading background, row stripes (or none), text. Headings on a dark background print in white |
| Logo | a PNG or JPEG, printed at the top right of the first page, with its width in mm |

In the texts you can use `&REPORT_TITLE.`, `&APP_NAME.`, `&APP_USER.`, `&DATE.`, `&TIMESTAMP.`,
page items (`&P1_DEPTNO.`) and text messages (`&APP_TEXT$NAME.`). **Preview PDF** on the layout
shows it with sample data.

A report uses the layout named in its region settings, otherwise the layout marked **default**,
otherwise the built-in look. In the region settings you can also choose the columns to print (in
that order, including columns that are hidden on screen), fixed widths in millimetres, and the
alignment:

```json
{
  "pdf": {
    "layout": "LETTERHEAD",
    "columns": ["ename", "job", "sal"],
    "widths": { "ename": 50 },
    "align": { "job": "center" }
  }
}
```

Layouts are part of the application export. The HR sample prints its *Directory* (page 11) with
the layout `HR_DIRECTORY` (seed `examples/hr/hr_07_layouts.sql`).

**Fonts:** the built-in PDF fonts cover Western European languages (Windows-1252). Characters
outside that set are printed as `?`. For other scripts, point `PDF_FONT` and `PDF_FONT_BOLD` to
TrueType fonts, for example DejaVu Sans or Noto Sans. They are embedded in the PDF.

### Printing a page

**Actions → Print** (or the browser's own print command) prints the page with a print
stylesheet. It leaves out the header, navigation, toolbars, buttons and pagination. Tables use
the full width, with headings repeated on each printed page. This works on every page, including
forms and dashboards.

### Document templates

Letters, invoices, certificates and employee sheets are **document templates** (APEX: Document
Generator), under **Shared Components → Document templates**:

| Field | Meaning |
|---|---|
| Name | `EMPLOYEE_SHEET`; pages download it with `?doc=EMPLOYEE_SHEET` |
| Title | The PDF's title, and `&REPORT_TITLE.` in the layout's footer |
| Data (SQL) | A SELECT with `:ITEM` binds, run as the application's role (grants and RLS apply) |
| Template (HTML) | The document: a subset of HTML with tags (below) |
| Report layout | Paper, orientation, margins, font size, colours, logo and footer ([report layouts](#report-layouts)); empty: the default layout |
| File name | e.g. `employee-&P3_EMPNO.` (`.pdf` is added) |
| Authorization | Who may download it, on top of access to the page |

**The data.** The first row's columns are available at the top level, all rows as `rows`, and
`json`/`jsonb` columns become lists and objects, so one query can bring an invoice and its lines:

```sql
select o.id, o.ordered_on, c.name as customer, o.total,
       (select json_agg(json_build_object('product', l.product, 'qty', l.qty, 'amount', l.amount) order by l.line_no)
          from shop.order_line l where l.order_id = o.id) as lines
  from shop.orders o join shop.customer c on c.id = o.customer_id
 where o.id = :P5_ORDER_ID::int
```

Built in: `APP_USER`, `APP_NAME`, `TODAY` and `NOW`. A query column of exactly one of these names
takes its place, and a column named `rows` is never seen (`{{rows}}` stays the list of all rows): the
Advisor warns about both (sprint 245). Tags are case-sensitive, so a column `today` is no `TODAY`.

**Tags.** Every value is HTML-escaped; there is no way to output data as markup.

| Tag | Meaning |
|---|---|
| `{{customer}}`, `{{order.customer.name}}` | A value (dotted paths into objects) |
| `{{total\|number:2}}`, `{{ordered_on\|date}}` | Filters: `number[:decimals]` (in the user's language), `date` and `datetime` (the app's formats), `upper`, `lower`, `default:text` |
| `{{#lines}}…{{/lines}}` | Repeated for each item of a list; entered for an object; shown when a value is true or non-empty |
| `{{^lines}}…{{/lines}}` | Shown when the list is empty (or the value false or empty) |
| `{{@index}}`, `{{.}}` | The position in the list (1, 2, …); the current item itself |
| `{{! comment }}` | Left out |

**HTML.** `h1`–`h4`, `p`, `div`, `br`, `b`/`strong`, `i`/`em`, `u`, `small`, `a href` (a link in the
PDF), `ul`/`ol`/`li`, `hr`, tables (`thead`, `tbody`, `tfoot`, `tr`, `th`, `td`; `width="30%"` or
`"40mm"` on the first row, `align`, `colspan`, `class="plain"` for a table without lines),
`<img src="logo" width="30mm">` (the layout's logo; `data:` PNG/JPEG images work too, and (sprint 253)
`src="stored:ITEM:key"`, a file in a file item's [object store](#stored-files-in-documents-and-mails); remote
images don't), `class="page-break"` on a `div` or `hr`, `align="right"`/`"center"` (or `class="right"`) and
`class="muted"`. A table's header rows repeat on every page it runs over; rows are never split.
`<p>&nbsp;</p>` is an empty line. Other tags show their text.

(sprint 245) **Inside a table cell or a paragraph:** `<br>` starts a new line (`<br><br>` leaves an
empty one); an `<img>` is drawn between the text around it, at its `width` in `mm`, in `%` of the cell
(or paragraph) or in pixels, never wider than the cell, and images that fit next to each other share a
line; the row grows to the tallest cell. A heading in a cell is bold at its size. So a logo goes
beside the title, and two signatures side by side:

```html
<table class="plain">
  <tr><td width="36mm"><img src="logo" width="32mm"></td>
      <td><h2>Work order {{id}}</h2>{{customer}}<br><span class="muted">{{address}}</span></td></tr>
</table>
<table class="plain">
  <tr><td>Customer<br><img src="data:image/png;base64,{{customer_signature}}" width="50mm"></td>
      <td>Engineer<br><img src="data:image/png;base64,{{engineer_signature}}" width="50mm"></td></tr>
</table>
```

(`encode(signature, 'base64') as customer_signature` in the query: a signature item's PNG.)

```html
<img src="logo" align="right" width="30mm">
<h1>Invoice {{id}}</h1>
<p>{{customer}} · {{ordered_on|date}}</p>
<table>
  <thead><tr><th width="60%">Product</th><th align="right">Qty</th><th align="right">Amount</th></tr></thead>
  {{#lines}}<tr><td>{{product}}</td><td align="right">{{qty}}</td><td align="right">{{amount|number:2}}</td></tr>{{/lines}}
  <tr><td colspan="2" align="right"><b>Total</b></td><td align="right"><b>{{total|number:2}}</b></td></tr>
</table>
```

**Downloading.** A button with action **document** and the template's name downloads it, filled
with the page's values as they were last loaded or saved (so save a changed form first); any link
can use `?doc=NAME` too. Item values in such a URL need their checksum like every link, and the
page's own access rules apply. Users who haven't signed in (on a page that doesn't require it) only
get the documents that page offers with a visible document button. The HR sample's employee form (page 3) has a *Print* button for the
`EMPLOYEE_SHEET` template.

**As a mail attachment.** (sprint 237) A *Send e-mail* process attaches a template as PDF with
`"attachments": {"document": "EMPLOYEE_SHEET", "items": {"P3_EMPNO": "&P3_EMPNO."}}`, and SQL with
`meta.add_mail_attachment(id, meta.document_pdf('EMPLOYEE_SHEET', jsonb_build_object('P3_EMPNO', 7839)), …)`:
drawn on the server as for a download ([Sending e-mail](06-processing.md#a-document-as-attachment)).
The HR sample's *Mail sheet* button does the latter.

**As a file to keep.** (sprint 245) `meta.document_temp_file(template, items, filename)` returns the id
(a `uuid`) of a [temporary file](#in-a-process-temporary-files) of the session that the server draws
as the template's PDF when the process that called it ends: in the same transaction, as the
application's role, with the data as the process left it, the session state and `items` (item name →
value) over it. From the **next** process of the same submit (or Ajax callback, dynamic action) on it
is a PDF like an uploaded file, so a signed form can be stored, attached or sent by a web request:

```sql
-- process 1 (a column named like the item sets it)
select meta.document_temp_file('WORK_ORDER', jsonb_build_object('P3_ID', :P3_ID),
                               'work-order-' || :P3_ID) as p3_pdf;
-- process 2
insert into sales.order_document (order_id, filename, mime_type, content)
select :P3_ID::int, filename, mime_type, content from meta.temp_files where id = :P3_PDF::uuid;
```

`filename` gets `.pdf` (without one: the template's file name). Within the calling process the file
is not drawn yet (its `size` is -1); a transaction never commits an undrawn one, so calling it outside
a page (a job, psql) fails with a clear message. The template's authorization scheme applies; at most
50 documents (with `meta.document_pdf`'s) per transaction. The HR sample's *Keep a copy* button on
the employee form stores the `EMPLOYEE_RECORD` template (a logo beside the title) among the
employee's documents (`examples/hr/hr_109_document_temp_file.sql`).

In the builder, **Preview PDF** under the template fills it with item values you type
(`P3_EMPNO=7839`), as the application's role, in a transaction that is rolled back. The template's
tags are checked when you save it; the Advisor also checks the query and templates that buttons
name.

The standard PDF fonts cover Western European text; set `PDF_FONT` (and `PDF_FONT_BOLD`) for other
scripts, as for report PDFs. APEX's Word and Excel templates and outputs have no equivalent: the
templates here are HTML and the output is PDF.

### Report queries

**Shared Components → Report Queries** (APEX: Report Queries, migration 104) are named queries an
application prints, without a template: the query's rows as a table.

| Property | Meaning |
|---|---|
| `name` | Pages download it with `?doc=NAME` (a document template of that name wins); a button with the action *document* names it |
| `query` | A SELECT with `:ITEM` binds (the page's session state), run as the application's role; its columns' names are the headings |
| `format` | `pdf` (with the report layout), `xlsx`, `csv`, `json`, `xml` or `html` |
| `layout` | A report layout for the PDF; empty: the default layout |
| `file_name`, `title` | The file's name without extension and the PDF's or HTML file's title (`&ITEM.` allowed); empty: the name, and the description or the name |
| `authz` | Who may download it, besides access to the page |

```
/a/sales/3?doc=ORDERS_BY_REGION        the file, with page 3's session state
```

The files are made like a download process's [data export](06-processing.md#data-export) (Excel and
PDF hold at most 100,000 rows) and are sent as attachments that a browser never shows as a page
(`Content-Security-Policy: sandbox`). Signed out, on a public page of an application with sign-in,
`?doc=` serves only the report queries and document templates of the page's own buttons.
