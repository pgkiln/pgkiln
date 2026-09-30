# 4. Pages and regions

## Pages

A page has a number (unique in the app), a name, a title, and these behaviours:

| Property | Values | Effect |
|---|---|---|
| `mode` | `normal`, `modal` | Modal pages open in a dialog over the page that linked to them. After a successful submit the dialog closes and the page below reloads (showing the success message). On phones the dialog is full screen. Opened directly, a modal page works as a normal page |
| `parent_page` | page number | Breadcrumb trail, and which menu entry is highlighted |
| `requires_auth` | boolean | `false` makes the page public in an app with a login |
| `authz` | scheme name | Who may open it (403 otherwise) |
| `protection` | `checksum`, `unrestricted` | Whether URL item values need a checksum |

### Layout

The page content is a **12-column grid**. Each region's `columns` (1–12) sets its width on desktops.
On tablets, regions of 6 columns or less pair up (two per row) and wider ones take the full
width; on phones every region takes the full width.

Region **templates**:

| `template` | Appearance |
|---|---|
| `standard` | A card with a header (title and buttons) and a body |
| `plain` | No frame and no header: content only (good for KPI cards and intro text) |
| `collapsible` | A standard card whose body can be collapsed by clicking the header |

Every region also has `seq` (order), `condition` (a SQL boolean expression; the region renders
only when true) and `authz` (an authorization scheme).

## Region types

| Type | Purpose |
|---|---|
| [`report`](#report-interactive-report) | Read-only table from a SELECT, with search, filters, sorting, paging and CSV download |
| [`grid`](#grid-interactive-grid) | Editable table on one database table |
| [`form`](#form) | Fields for one row of a table, with automatic fetch and save |
| [`chart`](#chart) | Bar, column, line, area or donut chart from a SELECT |
| [`cards`](#cards) | Cards or KPI tiles from a SELECT |
| [`calendar`](#calendar) | Month calendar of dated rows |
| [`facets`](#facets-faceted-search) | Checkbox filters with counts for a report |
| [`static`](#static-and-dynamic-content) | Fixed HTML with `&ITEM.` substitutions |
| [`dynamic`](#static-and-dynamic-content) | HTML produced by a SELECT |

Region-specific options go in the region's **attributes** (`config`, a JSON object).

---

### `report` (interactive report)

**Source**: any SELECT. Bind variables filter it:

```sql
select e.empno, e.ename, e.job, d.dname as department, e.sal
  from hr.emp e left join hr.dept d using (deptno)
 where :P2_DEPTNO is null or e.deptno = :P2_DEPTNO::int
```

Features for end users:

- **Search** across all columns.
- **Sort** by clicking a column heading (again for descending), or from the Actions menu.
- **Actions menu**: add **column filters** (`=`, `≠`, contains, does not contain, `>`, `≥`, `<`,
  `≤`, is empty, is not empty), choose **rows per page**, **download CSV**, **download PDF**,
  **print**, **reset**.
- Active search and filters appear as removable chips.
- **Paging** with Previous/Next.
- On phones every row **reflows** into a card with labelled values.

The report's state lives in the URL (`?r12_q=…&r12_s=3&r12_d=desc`), so it can be bookmarked and
shared. Everything the user enters is applied safely: search and filter values become literals,
filter columns must exist in the result, sort positions are integers.

Attributes:

| Key | Default | Meaning |
|---|---|---|
| `page_size` | `15` | Rows per page (the user can change it) |
| `searchable` | `true` | Show the search box (`false` = a "classic report") |
| `interactive` | `true` | Show the Actions menu (only when searchable) |
| `sortable` | `true` | Allow sorting (`false` keeps the query's order, e.g. for trees) |
| `mobile` | `"reflow"` | `"scroll"` keeps a horizontally scrolling table on phones |
| `hidden` | `[]` | Column names to leave out of the display (they can still be used in links) |
| `headings` | `{}` | Column headings, e.g. `{"sal": "Salary"}`; by default `hire_date` becomes "Hire Date" |
| `link` | none | Makes one column a link: `{"column": "empno", "page": 3, "items": {"P3_EMPNO": "#empno#"}}`. `#col#` is replaced by the row's value; the link carries a checksum and is hidden when the user may not open that page |
| `empty` | "No data found" | Text when there are no rows |
| `preformatted` | `[]` | Columns shown with preserved spaces (e.g. indented trees) |

Items placed **in** a report region appear in its toolbar; that's how filter fields (for example
a department select list with `submit_on_change`) are made.

The CSV download uses the current search, filters and sort (up to 100,000 rows). Text cells that
start with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets don't execute them.
The PDF uses them too; see [printing](16-files.md#printing).

---

### `grid` (interactive grid)

An editable table on **one** table. Required properties: `table_name` (e.g. `hr.dept`),
`pk_column` (single-column primary key) and a `source` SELECT that includes the key column:

```sql
select deptno, dname, loc from hr.dept
```

It is saved by a **process of type `grid_dml`** whose region is the grid, which the wizard
creates. **Without such a process the grid is read-only.**

End users can edit cells inline, add rows (**Add row**), tick rows for deletion, search, page, and
**Save**. On save:

- only **changed** cells are written (each row posts its original values);
- new rows with at least one value are inserted; blank ones are ignored;
- ticked rows are deleted;
- if any row fails (a constraint, trigger, RLS or a missing required value), **nothing** is saved
  and each problem is reported with its row number;
- the user is warned before leaving the page with unsaved changes.

Which columns are editable: columns of `table_name` that appear in the SELECT, except the
primary key, generated columns, `GENERATED ALWAYS` identity columns and `readonly` ones. Other
selected columns (e.g. from a join) are shown read-only. Each existing row's key is signed, so a
user cannot redirect an update or delete to another row by editing the page.

Attributes:

| Key | Default | Meaning |
|---|---|---|
| `page_size` | `25` | Rows per page (max 200) |
| `allow` | all `true` | `{"insert": false, "update": true, "delete": false}` |
| `readonly` | `[]` | Columns that may not be edited |
| `columns` | `{}` | Per column: `{"deptno": {"lov": "LOV:DEPARTMENTS", "required": true}}`. `lov` makes it a select list (any [list of values](05-items.md#lists-of-values)) |
| `headings`, `hidden` | | As for reports |

Cell editors follow the column type: number, date, date-time, checkbox (boolean), select list
(with `lov`) or text.

---

### `form`

A form edits **one row** of `table_name`, identified by `pk_column`, whose value is kept in the
item `pk_item` (usually a hidden item). Every item in the region with a `source_column` maps to
that column.

- **Fetch**: when the page is shown and `pk_item` has a value, the row is read into the items. A
  row that doesn't exist (or is hidden by RLS) gives "record not found".
- **Save**: a process of type **`form_dml`** does the DML according to the pressed button:

| Button name | Operation |
|---|---|
| `CREATE`, `INSERT`, `ADD` | `INSERT` of the non-empty item values (empty columns get their default); the new key is stored in `pk_item` |
| `SAVE`, `UPDATE`, `APPLY`, `APPLY_CHANGES` | `UPDATE` of all editable mapped items |
| `DELETE` | `DELETE` (validations are skipped) |

Typical form buttons (as generated by the wizard): *Cancel* (redirect), *Delete* (condition
`:P3_ID is not null`), *Apply Changes* (same condition) and *Create* (condition `:P3_ID is null`).

The easiest way to get a form is the **Report and form** wizard, which opens the form as a modal
dialog from the report.

---

### `chart`

**Source**: the **first column is the label**; **each further numeric column is a series**, named
by its column alias:

```sql
select d.dname as department,
       sum(e.sal)  as "Salary",
       sum(e.comm) as "Commission"
  from hr.dept d left join hr.emp e using (deptno)
 group by d.dname order by 1
```

Attributes: `{"kind": "bar" | "column" | "line" | "area" | "donut"}` (default `bar`).

| Kind | Best for | Notes |
|---|---|---|
| `bar` | ranking categories with long labels | horizontal bars, values at the tips |
| `column` | comparing a few categories or series | values on the caps for ≤ 12 categories |
| `line` / `area` | change over time | label column should be ordered (dates, years) |
| `donut` | parts of a whole (≤ 6 slices) | uses the first series; more than 6 slices fold into "Other" |

Up to 8 series; two or more get a legend. Every chart has hover/focus **tooltips** and a
**Data table** toggle (the accessible alternative). Colours come from a palette checked for
colour-vision deficiency, in light and dark mode. Charts resize with the screen.

---

### `cards`

**Source**: a SELECT with any of these columns: `title`, `subtitle`, `body`, `badge`, `icon`
(an [icon name](09-reference.md#icons)). Other columns can be used in the link.

```sql
select d.dname as title, initcap(d.loc) as subtitle,
       count(e.empno) || ' employees' as body, d.deptno as badge, 'building' as icon, d.deptno
  from hr.dept d left join hr.emp e using (deptno) group by d.deptno
```

Attributes:

| Key | Meaning |
|---|---|
| `style` | `"metric"`: KPI tiles with a big value (`badge`) and a label (`title`) |
| `link` | `{"page": 5, "items": {"P5_DEPTNO": "#deptno#"}}` makes each card a link |
| `empty` | Text when there are no rows |

---

### `calendar`

**Source**: a SELECT with `start_date`, optional `end_date` (inclusive, for multi-day events) and
`title`, plus any columns used in the link:

```sql
select l.start_date, l.end_date, initcap(e.ename) as title, l.id
  from hr.leave_request l join hr.emp e using (empno)
```

Attributes: `{"link": {"page": 7, "items": {"P7_ID": "#id#"}}}`.

Tablets and desktops see a month grid (Monday first, up to 4 events per day plus "+n more");
phones see an agenda list of the days with events. Users move between months with ‹, *Today*
and › (`?r<id>_m=2026-10`).

---

### `facets` (faceted search)

A panel of checkbox filters, each with a live count, that filters a **report region on the same
page**. Counts take the search and all *other* facets into account.

Attributes:

```json
{"report": 57,
 "facets": [{"column": "job", "label": "Job"},
            {"column": "department"},
            {"column": "status", "limit": 5}]}
```

| Key | Meaning |
|---|---|
| `report` | The id of the report region to filter |
| `facets[].column` | A column of the report's SELECT |
| `facets[].label` | Heading (default: the column name) |
| `facets[].limit` | Most frequent values shown (default 12, max 50) |

Typical layout: facets region with `columns: 3` and template `collapsible`, report with
`columns: 9`. On phones the facets stack above the report.

---

### `static` and `dynamic` content

- **`static`**: `source` is HTML written by the developer, with `&ITEM.` substitutions
  (HTML-escaped). Items placed in the region are rendered below the HTML.
- **`dynamic`**: `source` is a SELECT; the first column of each row is output as HTML, like APEX's
  "PL/SQL Dynamic Content". The SQL is trusted, so **escape data** with `meta.html_escape()`:

```sql
select '<ul>' || string_agg('<li>' || meta.html_escape(ename) || '</li>', '') || '</ul>'
  from hr.emp where job = 'MANAGER'
```

The content security policy blocks inline `<script>` and event handler attributes in both.
