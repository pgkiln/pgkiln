# 16. Files, data loading and printing

This chapter covers three things that deal with files:

- **file upload items**, where users upload files into a table or a process;
- **data loading**, which loads CSV and Excel files into tables, from the SQL Workshop or from
  an application page;
- **downloads and printing**: reports as CSV, Excel and PDF (with adjustable report layouts),
  and printing any page from the browser.

| APEX | pgapex |
|---|---|
| File Browse item, storage "BLOB column specified in item source" | Item type `file` with a bytea `source_column` in a form region |
| File Browse item, storage "Table APEX_APPLICATION_TEMP_FILES" | Item type `file` without a source column; read the file from `meta.temp_files` |
| SQL Workshop → Data Workshop → Load Data | SQL Workshop → **Load Data** |
| Data Load Definition + "Execute Data Load" process | Process type `data_load` |
| Interactive report → Download → CSV / Excel / PDF | Actions → **Download CSV / Excel / PDF** |
| Shared Components → Report Layouts | Shared Components → **Report layouts** |
| Print (browser) | Actions → **Print**, and a print stylesheet on every page |

## File upload items

A `file` item shows a file input. When the page is submitted, the uploaded file is stored as a
**temporary file of the session**, and the item's value becomes that file's id (a uuid). The
upload is kept when validation fails, so users don't have to choose the file again. Where the
file goes next depends on the item.

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
  shows the session's own files.
- **Audit trails:** keep file contents out of JSON audit logs. The HR sample's `hr.audit()`
  takes a list of columns to leave out: `hr.audit('empno', 'photo')`.

Large files in bytea columns are fine up to tens of megabytes. For bigger files or large numbers
of them, store them in object storage and keep the key in the table.

## Data loading

Both ways of loading accept:

- CSV and TSV: UTF-8 with or without BOM, or Windows-1252. The delimiter `,` `;` tab or `|` is
  detected. Quoted fields can contain delimiters, `""` and line breaks.
- Excel `.xlsx`: the first sheet. Numbers keep their exact text and dates become `YYYY-MM-DD`.

The first row holds the column names. Empty cells become NULL. Rows are inserted in batches; if
a batch fails, its rows are retried one by one to find the bad rows. **When a row fails, nothing
is loaded**, and you get a list of the failed rows with their errors. To load the good rows and
skip the others instead, tick *Skip rows with errors* (or use `skip_errors` in a process).

### SQL Workshop → Load Data

1. Choose a file (up to `DATA_LOAD_MAX_MB`, default 50 MB, and `DATA_LOAD_MAX_ROWS` rows).
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
3. The result shows the rows inserted, updated and skipped, with a link to the table in the
   Object Browser.

Load Data runs as the builder's owner connection, like SQL Commands.

### Data loading in an application

For end users, add a page with a `file` item and a button, and a **process of type
`data_load`**. The process runs **as the application's database role**, so grants, row level
security, triggers and the audit trail apply, just as they do for the form.

| `config` key | Meaning |
|---|---|
| `file_item` | The file item (required) |
| `table` | Target table (required) |
| `mode` | `append` (default), `merge` or `replace` |
| `skip_errors` | `true`: load the good rows and list the skipped ones |
| `headers` | `false` when the file has no heading row (then use `columns` with `column_1`, `column_2`, …) |
| `columns` | Mapping `{"Heading in the file": "column"}`; without it, columns are matched by name |

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

Try it with `/static/samples/employees.csv`. A salary above the president's is refused by the
database trigger, and then nothing is loaded.

## Downloads and printing

### Report CSV and Excel

Every interactive report has **Actions → Download CSV** and **Download Excel**. Both contain the
rows of the report as on screen: the same query, search, filters, facets and sort, the same
headings and hidden columns, and the same access checks (page authorization, region visibility,
row level security). They hold at most 100,000 rows.

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
most `PDF_MAX_ROWS` rows (default 5000); if there are more, it says so. The CSV and Excel
downloads have all rows.

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
the layout `HR_DIRECTORY` (seed `db/seed/hr_07_layouts.sql`).

**Fonts:** the built-in PDF fonts cover Western European languages (Windows-1252). Characters
outside that set are printed as `?`. For other scripts, point `PDF_FONT` and `PDF_FONT_BOLD` to
TrueType fonts, for example DejaVu Sans or Noto Sans. They are embedded in the PDF.

### Printing a page

**Actions → Print** (or the browser's own print command) prints the page with a print
stylesheet. It leaves out the header, navigation, toolbars, buttons and pagination. Tables use
the full width, with headings repeated on each printed page. This works on every page, including
forms and dashboards.

### Not included

Report layouts shape table reports. APEX can also fill designed documents such as invoices
and letters from a template (BI Publisher, APEX Office Print, the 24.2+ document generator).
pgapex doesn't have document templates yet. Until then:

- a dynamic content region with a print-friendly HTML layout, printed from the browser, works
  well for simple documents;
- for designed PDFs, generate them outside pgapex (for example a small service with a template
  engine) and store the result in a bytea column with a file item.
