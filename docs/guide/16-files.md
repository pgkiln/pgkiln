# 16. Files, data loading and printing

This chapter covers three things that deal with files:

- **file upload items**, where users upload files into a table or a process;
- **data loading**, which loads CSV, Excel, JSON and XML files into tables, from the SQL
  Workshop or from an application page, optionally with a saved data load definition;
- **downloads and printing**: reports as CSV, Excel and PDF (with adjustable report layouts),
  and printing any page from the browser.

| APEX | pgapex |
|---|---|
| File Browse item, storage "BLOB column specified in item source" | Item type `file` with a bytea `source_column` in a form region |
| File Browse item, storage "Table APEX_APPLICATION_TEMP_FILES" | Item type `file` without a source column; read the file from `meta.temp_files` |
| File Browse item, "Allow Multiple Files" | Item type `file` with `"multiple": true`: one row per file in a child table, or a list of temporary files |
| SQL Workshop → Data Workshop → Load Data | SQL Workshop → **Load Data** |
| SQL Workshop → Data Workshop → Unload Data | SQL Workshop → **Unload Data** |
| Shared Components → Data Load Definitions | Shared Components → **Data load definitions** |
| Data Load Definition + "Execute Data Load" process | Process type `data_load` with `"definition"` |
| Interactive report → Download → CSV / Excel / PDF | Actions → **Download CSV / Excel / PDF** |
| Shared Components → Report Layouts | Shared Components → **Report layouts** |
| Print (browser) | Actions → **Print**, and a print stylesheet on every page |

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

**Without a child table** the files stay temporary, as with a single file. Read them in a process:

```sql
insert into doc.attachment (ticket_id, name, mime_type, content)
select :P5_TICKET_ID::int, filename, mime_type, content
  from meta.temp_files
 where id = any (string_to_array(:P5_FILES, ':')::uuid[]);
```

A session keeps at most 20 temporary files, so keep `max_files` at 10 or less (the server caps
it at 10) and save the files before users upload many more.

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
  `employees/employee`), or leave it empty and pgapex takes the element that occurs most often
  among the elements with children or attributes. The columns are the row element's attributes
  (`@empno`), its child elements (`ename`) and deeper elements by path (`address/city`,
  `address/@type`); a row element holding only text is one column. Namespace prefixes are
  dropped. CDATA, character references and the five predefined entities are read. **Document
  type declarations (`<!DOCTYPE …>`) and entity declarations are refused**, so no external
  entities are fetched and no entity expansion ("billion laughs") is possible; nesting is limited
  to 100 levels. The reader is pgapex's own (`src/xml.ts`), not a library.

For CSV and Excel, the first row holds the column names (untick it when it doesn't). The format
is detected from the file name and its first bytes. Empty cells become NULL. Rows are inserted in batches; if
a batch fails, its rows are retried one by one to find the bad rows. **When a row fails, nothing
is loaded**, and you get a list of the failed rows with their errors. To load the good rows and
skip the others instead, tick *Skip rows with errors* (or use `skip_errors` in a process).

### SQL Workshop → Load Data

1. Choose a file (up to `DATA_LOAD_MAX_MB`, default 50 MB, and `DATA_LOAD_MAX_ROWS` rows). For
   XML you can name the row element. To load with a [data load
   definition](#data-load-definitions), choose it here: the next step previews the file after its
   mapping and transformations and loads it into the definition's table with its mode.
2. Check the preview, then choose where the data goes:
   - **New table:** pgapex suggests column names (`Hire Date` → `hire_date`) and types from the
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

Load Data runs as the builder's owner connection, like SQL Commands.

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

Unload Data runs as the builder's owner connection (any table the owner can read), on a connection
of its own in a **read-only transaction**: a statement other than one SELECT is refused, and a
data-modifying `with`, `select … into` or a function that writes fails. Each statement has a
timeout (`UNLOAD_STATEMENT_TIMEOUT`, default `5min`). A failing query shows its error on the form;
an error after the first rows (e.g. the timeout) ends the file early. Every unload is recorded in
the activity log (event `sql_unload`, with the format and the statement).

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
`data_load`**. The process runs **as the application's database role**, so grants, row level
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

Built in: `APP_USER`, `APP_NAME`, `TODAY` and `NOW`.

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
`<img src="logo" width="30mm">` (the layout's logo; `data:` PNG/JPEG images work too, remote images
don't), `class="page-break"` on a `div` or `hr`, `align="right"`/`"center"` (or `class="right"`) and
`class="muted"`. A table's header rows repeat on every page it runs over; rows are never split.
`<p>&nbsp;</p>` is an empty line. Other tags show their text.

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
page's own access rules apply. The HR sample's employee form (page 3) has a *Print* button for the
`EMPLOYEE_SHEET` template.

In the builder, **Preview PDF** under the template fills it with item values you type
(`P3_EMPNO=7839`), as the application's role, in a transaction that is rolled back. The template's
tags are checked when you save it; the Advisor also checks the query and templates that buttons
name.

The standard PDF fonts cover Western European text; set `PDF_FONT` (and `PDF_FONT_BOLD`) for other
scripts, as for report PDFs. APEX's Word and Excel templates and outputs have no equivalent: the
templates here are HTML and the output is PDF.
