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
| [`report`](#report-interactive-report) | Read-only table from a SELECT, with search, filters, sorting, control break, aggregates, highlights, computed columns, group by, pivot and chart views, row selection, saved reports, paging and CSV/Excel/PDF download |
| [`grid`](#grid-interactive-grid) | Editable table on one database table |
| [`form`](#form) | Fields for one row of a table, with automatic fetch and save |
| [`chart`](#chart) | Bar, column, stacked, line, area, combo, scatter, bubble, donut, pie, gauge, funnel or radar chart from a SELECT, with drill-down links |
| [`cards`](#cards) | Cards or KPI tiles from a SELECT |
| [`calendar`](#calendar) | Month, week, day and list views of dated rows, with create on click and drag and drop |
| [`facets`](#facets-faceted-search) | Checkbox, range and star filters with counts and a search field for a report |
| [`smart_filters`](#smart_filters) | One search field with filter chips and suggestions for a report |
| [`display_selector`](#display_selector-region-display-selector) | Tabs or a select list that show one region (or group of regions) of the page at a time |
| [`map`](#map) | Places (markers) and shapes on an interactive map |
| [`tree`](#tree) | Rows with a parent as an expandable tree |
| [`template_component`](#template-components) | Each row (or all rows) of a SELECT through a template component: badges, contact cards, timelines, your own |
| [`tasks`](06-processing.md#approvals-and-the-task-list) | Task list: approvals and actions for the signed-in user |
| [`workflows`](06-processing.md#workflows) | Workflow console: the workflows the user started or administers |
| [`static`](#static-and-dynamic-content) | Fixed HTML with `&ITEM.` substitutions |
| [`dynamic`](#static-and-dynamic-content) | HTML produced by a SELECT |

Region-specific options go in the region's **attributes** (`config`, a JSON object).

---

### Regions on a REST data source

Every region type that reads a query (report, grid without saving, chart, cards, calendar, map,
tree, template component) can read a **REST data source** instead of a table: set the region's
**REST data source** property. Its **Source** is then optional SQL over a CTE named `rest`
(`select * from rest where …`), and parameters go into `{"rest_params": {"city": "&P1_CITY."}}`
in the attributes. See [chapter 19](19-rest-data-sources.md#regions-on-a-rest-data-source).

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
- **Actions menu**:
  - **column filters** (`=`, `≠`, contains, does not contain, `>`, `≥`, `<`, `≤`, is empty, is
    not empty) and **sort**;
  - **control break**: group the rows by a column, with a heading row per group;
  - **aggregates**: sum, average, count, minimum or maximum of a column, over all filtered rows
    (not just the page). A *Total* row closes the table, and with a control break every group
    gets a *Subtotal*;
  - **highlight**: color the rows that match a condition (yellow, green, red, blue or gray; the
    first matching rule wins);
  - **compute**: add a column calculated from others, e.g. *Year pay* = `sal * 12` (see
    [computed columns](#computed-columns)); it can be filtered, sorted, aggregated and highlighted
    like any column;
  - **group by**: up to three columns, with the number of rows and any sums, averages, counts,
    minimums or maximums per group;
  - **pivot**: one column's values as columns (up to 30), with a function of a value column in
    the cells and a total per row, e.g. salary per department × job;
  - **chart**: a bar, column, line, area, donut or pie chart of a function per label column (up to
    50 labels), with its data table. The chart view has one series, so the stacked, combo and
    scatter kinds are only available in a chart region;
  - **saved reports**: save the current search, filters, sort, break, aggregates, highlights,
    computed columns and views under a name, and switch between saved reports (below);
  - **rows per page**, **download CSV / Excel / PDF**, **print**, **reset**.
- Active search, filters, break, aggregates, highlights, computed columns and views appear as
  removable chips. Once a group by, pivot or chart is set, **Report / Group by / Pivot / Chart**
  links switch between the views; all views use the same search, filters and facets.
- **Paging** with Previous/Next.
- On phones every row **reflows** into a card with labelled values.

The report's state lives in the URL (`?r12_q=…&r12_s=3&r12_d=desc&r12_b=job&r12_a=sum|sal&r12_h=sal|gt|green|3000`),
so it can be bookmarked and shared. Everything the user enters is applied safely: search, filter
and highlight values become literals, columns must exist in the result, operators, aggregate
functions, chart types and colors come from fixed lists, sort positions are integers, and computed
column expressions are parsed (below), never pasted into SQL.

### Computed columns

An expression uses the report's columns by name (case doesn't matter; quote names with spaces as
`"Total pay"`), numbers, text in single quotes, `+ - * /`, `||` to join text, parentheses and these
functions: `abs ceil floor round trunc mod power upper lower initcap length trim substr left right
replace concat coalesce nullif greatest least`. Division returns a decimal number, and `x / 0`
gives an empty value instead of an error. Up to five per report; an expression that doesn't parse
is shown as an error and left out, so the report keeps working.

```
sal * 12 + coalesce(comm, 0)
upper(ename) || ' (' || job || ')'
round(sal / 12, 2)
```

### Row selection

`"selection": {"column": "empno", "item": "P2_SELECTED"}` puts a checkbox in front of every row
(with *select all* in the header). When the page is submitted, the checked rows' values reach the
item, colon separated (`7839:7902`), like a checkbox group; a process can then work on them:

```sql
update hr.emp set active = false
 where empno = any(string_to_array(:P2_SELECTED, ':')::int[]);
```

The item must be on the same page and is usually `hidden`; it accepts posted values only because
the selection names it. The values come from the browser, so treat them as user input (RLS and
your process's own checks apply). Only the rows on the current page can be selected.

**Saved reports** (like APEX's saved interactive reports) belong to the signed-in user. A
region with `"public_reports": "ADMIN"` lets users who pass that authorization scheme save
**public** reports, which everyone who can see the report can apply; only the owner can
delete a report. Saved reports are user data: they stay in `meta.saved_report` and aren't part
of the application export.

Attributes (most of them are also in the page designer's **Report settings** form):

| Key | Default | Meaning |
|---|---|---|
| `page_size` | `15` | Rows per page (the user can change it, up to 500) |
| `pagination` | X–Y of Z | `"range"`: "Rows X–Y" without a total, for large tables (see [large tables](#large-tables)) |
| `keyset` | none | With `"range"`: columns that make a row unique (e.g. `["id"]`); Next/Previous seek instead of using an offset (see [large tables](#large-tables)) |
| `max_rows` | none | Maximum row count: the report, its total and its downloads read at most this many rows (1 to 1,000,000) |
| `lazy` | `false` | Load the region after the page shows (see [large tables](#large-tables)) |
| `cache` | none | Keep the rendered region: `{"scope": "user" \| "session" \| "all", "seconds": 300}` |
| `searchable` | `true` | Show the search box (`false` = a "classic report") |
| `interactive` | `true` | Show the Actions menu (only when searchable) |
| `sortable` | `true` | Allow sorting (`false` keeps the query's order, e.g. for trees) |
| `mobile` | `"reflow"` | `"scroll"` keeps a horizontally scrolling table on phones |
| `hidden` | `[]` | Column names to leave out of the display (they can still be used in links) |
| `headings` | `{}` | Column headings, e.g. `{"sal": "Salary"}`; by default `hire_date` becomes "Hire Date" |
| `link` | none | Makes one column a link: `{"column": "empno", "page": 3, "items": {"P3_EMPNO": "#empno#"}}`. `#col#` is replaced by the row's value; the link carries a checksum and is hidden when the user may not open that page |
| `empty` | "No data found" | Text when there are no rows |
| `preformatted` | `[]` | Columns shown with preserved spaces (e.g. indented trees) |
| `saved_reports` | `true` | `false` hides saved reports for this report |
| `public_reports` | none | Authorization scheme whose users may save public reports |
| `pdf` | none | PDF layout, columns and widths; see [report layouts](16-files.md#report-layouts) |
| `selection` | none | Row selection: `{"column": "empno", "item": "P2_SELECTED"}` (see [row selection](#row-selection)) |

Items placed **in** a report region appear in its toolbar; that's how filter fields (for example
a department select list with `submit_on_change`) are made.

The CSV and Excel downloads use the current search, filters and sort, grouped by the control
break column when there is one (up to `DOWNLOAD_MAX_ROWS`, default 1,000,000, or the report's `max_rows`).
They are streamed from a database cursor, so the server holds one batch of 1,000 rows at a time. Text cells that start with `=`, `+`, `-` or
`@` are prefixed with `'` in CSV so spreadsheets don't execute them. The PDF uses them too; see
[downloads and printing](16-files.md#downloads-and-printing). Computed columns are included in the
downloads; highlights, aggregates and the group by, pivot and chart views are shown on screen only.

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
| `pagination`, `max_rows` | | As for reports |
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

Attributes:

| Key | Meaning |
|---|---|
| `kind` | `bar` (default), `column`, `stacked`, `line`, `area`, `combo`, `scatter`, `bubble`, `donut`, `pie`, `gauge`, `funnel` or `radar` |
| `link` | Drill-down: `{"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}` makes every data point a link (see below) |
| `gauge` | For `gauge`: `{"min": 0, "max": 120, "warning": 80, "critical": 100}` (all optional) |
| `empty` | Text when there are no rows |

| Kind | Best for | Notes |
|---|---|---|
| `bar` | ranking categories with long labels | horizontal bars, values at the tips |
| `column` | comparing a few categories or series | values on the caps for ≤ 12 categories |
| `stacked` | parts of a total per category | one column per label with the series stacked on top of each other; negative values stack downwards |
| `line` / `area` | change over time | label column should be ordered (dates, years) |
| `combo` | two measures with one shared label | the **first series is drawn as columns**, the other series as lines over them |
| `scatter` | the relation between two numbers | the **first column must be numeric** (the x axis); each further column is a y value. Rows with an empty or non-numeric x are left out. The axes don't have to start at zero |
| `donut` / `pie` | parts of a whole (≤ 6 slices) | uses the first series; more than 6 slices fold into "Other"; zero and negative values are left out. The donut shows the total in the middle |
| `bubble` | three measures per item | label, then **x, y and size** columns; the bubble's area is proportional to the size. The axes don't have to start at zero |
| `gauge` | one value against a target, per row | a half dial per row (up to 12) from `min` (default 0) to `max` (default: rounded up from the values). With `warning` and/or `critical` thresholds each dial shows a status (*On target*, *Warning*, *Critical*) with an icon and a label, and the thresholds as a coloured ring. A `warning` above `critical` means low values are bad |
| `funnel` | stages of a process | the first series, in the query's order (sort it); each stage shows its share of the first stage |
| `radar` | several measures per series, side by side | **one axis per row** (3 to 12 rows), one polygon per series, all on one scale from zero |

A stacked chart, a combination of columns and a line, and a scatter plot:

```sql
-- stacked: one column per department, a segment per job
select d.dname as department,
       count(e.empno) filter (where e.job = 'CLERK')    as "Clerk",
       count(e.empno) filter (where e.job = 'SALESMAN') as "Salesman",
       count(e.empno) filter (where e.job = 'ANALYST')  as "Analyst"
  from hr.dept d left join hr.emp e using (deptno)
 group by d.dname order by 1

-- combo: the budget as columns, the average as a line
select initcap(job) as job, sum(sal) as "Salary budget", round(avg(sal)) as "Average salary"
  from hr.emp group by job order by 2 desc

-- scatter: x = years of service, y = salary
select extract(year from age(current_date, hiredate))::int as "Years of service", sal as "Salary"
  from hr.emp where active order by 1
```

A bubble chart, gauges, a funnel and a radar (HR page 24 "Planner"):

```sql
-- bubble: x = years of service, y = average salary, size = headcount (deptno only for the link)
select d.dname as department,
       round(avg(extract(year from age(current_date, e.hiredate)))::numeric, 1) as "Years of service",
       round(avg(e.sal)) as "Average salary", count(*) as "Employees", d.deptno
  from hr.emp e join hr.dept d using (deptno) group by d.deptno, d.dname

-- gauge, {"gauge": {"max": 120, "warning": 80, "critical": 100}}: one dial per department
select d.dname, round(100.0 * coalesce(sum(e.sal), 0) / 10000) as "Budget used", d.deptno
  from hr.dept d left join hr.emp e on e.deptno = d.deptno group by d.deptno, d.dname

-- funnel: stages in order
select 'Requested' as stage, count(*) as "Requests" from hr.leave_request
union all select 'Approved', count(*) filter (where status = 'APPROVED') from hr.leave_request

-- radar: an axis per job, a polygon per department
select initcap(job) as job,
       count(*) filter (where deptno = 10) as "Accounting",
       count(*) filter (where deptno = 20) as "Research"
  from hr.emp group by job order by 1
```

Up to 8 series; two or more get a legend. Every chart has hover/focus **tooltips** and a
**Data table** toggle (the accessible alternative). Colours come from a palette checked for
colour-vision deficiency, in light and dark mode; the gauge's status colours are reserved for
status and always come with an icon and a label. Charts resize with the screen.

#### Drill-down links

With `link`, every data point is a link to a page, like a report link: `#column#` in the item
values is replaced by the value of the point's row, and `#series#` by the name of its series (the
column alias). The URL carries a checksum, so pages with session state protection accept it, and
there are no links when the user may not open the target page.

```json
{"kind": "column", "link": {"page": 9, "items": {"P9_DEPTNO": "#deptno#", "P9_JOB": "#series#"}}}
```

Columns that only the link refers to (here `deptno`) are **not drawn** as a series, so the query
can return a key next to the label. What links: bars, columns and stacked segments (per series),
line and area points, scatter dots and bubbles, gauge dials, funnel stages, radar axis labels, pie
and donut slices and their legend entries (not "Other"). The marks are for the mouse; from the
keyboard the **data table** has the same links (the labels, or each value when there are several
series), and so do the radar labels and donut legend.

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
| `max_rows` | Most cards shown (default 500); when there are more, "Showing the first 500 rows." follows |

---

### `calendar`

**Source**: a SELECT with `start_date`, optional `end_date` (inclusive, for multi-day events) and
`title`, plus any columns used in the link:

```sql
select l.start_date, l.end_date, initcap(e.ename) as title, l.id
  from hr.leave_request l join hr.emp e using (empno)
```

`start_date` and `end_date` can be dates (all-day events) or timestamps (events with a time; a
timestamp at midnight without an end time counts as all-day).

Attributes:

| Key | Meaning |
|---|---|
| `link` | `{"page": 7, "items": {"P7_ID": "#id#"}}`: each event links to a page (the edit link) |
| `views` | The views users can switch between, from `["month", "week", "day", "list"]` (default: all four) |
| `view` | The view shown first (default: the first of `views`) |
| `day_start`, `day_end` | The hours of the week and day views (default 8 to 18); widened when an event needs it |
| `create` | Create on click: `{"page": 7, "items": {"P7_START": "#start#", "P7_END": "#end#"}}` |
| `move` | Drag and drop: SQL that moves an event (see below) |
| `key` | The column that identifies an event for `move` (default `id`) |
| `move_authz` | An authorization scheme for dragging (default: everyone who sees the calendar) |

**Views.** *Month*: a grid, Monday first, up to 4 events per day plus "+n more" (a link to that
day); phones see an agenda list of the days with events. *Week* and *Day*: an "All day" row and a
row per hour, each timed event in the hour it starts, with its times; on phones the week view is
an agenda list too. *List*: the month's events per day. The buttons ‹, *Today* and › move by a
month, week or day; *Month / Week / Day / List* switch views. Everything is a plain link
(`?r<id>_v=week&r<id>_d=2026-10-05`, `?r<id>_m=2026-10` for month and list), so it works without
JavaScript and can be bookmarked.

**Create on click.** With `create`, every day (month view, "All day" row) and every hour slot has a
**+** link to the page, with `#start#`, `#end#` and `#date#` filled in: `2026-10-05` for a day,
`2026-10-05 09:00` and `2026-10-05 10:00` for an hour. The link carries a checksum like every
link (so the target page can keep session state protection on); with JavaScript a click anywhere
on an empty part of the slot follows it. A date item takes the date; a date-time item shows a day
as midnight.

**Drag and drop.** With `move`, users drag events with the mouse to another day or hour slot. The
browser sends the event's key and the slot; the server checks the CSRF token, the page's and the
region's authorization and condition, `move_authz`, and that the event is **in the region's query
for this user** (as the application's database role, so row level security applies), works out the
new start and end (an event keeps its length; a timed event dropped on an hour starts there, else
it moves by whole days and keeps its time of day) and runs `move` as the application's role with
three binds:

| Bind | Value |
|---|---|
| `:EVENT_ID` | the key column's value |
| `:NEW_START` | `2026-10-07` or `2026-10-07 14:00` (the same form as the old start) |
| `:NEW_END` | the new end, or NULL when the event has none |

```json
{"move": "select hr.move_meeting(:EVENT_ID::int, :NEW_START::timestamp, :NEW_END::timestamp)"}
```

Put your own rules in the function (raise an exception with a message for the user, e.g. "Only
the organizer can move this meeting."); the calendar redraws itself after a move and shows the
error otherwise. Binds are replaced as literals outside quotes, so call a function rather than
using them inside a `DO` block. Without a mouse (keyboard, touch, no JavaScript), the event's edit
link is the way to change its dates.

---

### `facets` (faceted search)

A panel of filters, each with a live count, that filters a **report region on the same page**.
Counts take the search and all *other* facets into account. Three kinds of facet:

- **checkbox** (the default): the most frequent values of a column, each with a checkbox. With
  `"exclude": true` the facet gets an *Exclude the selected values* switch: the chosen values are
  then left out instead (rows where the column is empty stay).
- **range**: a number or date column in ranges, as radio buttons ("Any", then each range). A
  range includes its `from` and excludes its `to`, so `..1500`, `1500..3000` and `3000..` don't
  overlap. With `"custom": true` (the default when no `ranges` are given) users can type their own
  *from* and *to*; those are inclusive (a date *to* includes the whole day).
- **star**: a rating column as "5 stars and up", "4 stars and up", … down to 1 (`max`, default 5).

With `"search": true` the panel starts with a search field: the same search as the report's own
(`r<id>_q`, the row as text contains the term).

Attributes:

```json
{"report": 57,
 "search": true,
 "facets": [{"column": "job", "label": "Job", "exclude": true},
            {"column": "department"},
            {"column": "status", "limit": 5},
            {"column": "sal", "label": "Salary", "type": "range", "custom": true,
             "ranges": [{"to": 1500, "label": "Below 1500"}, {"from": 1500, "to": 3000}, {"from": 3000}]},
            {"column": "hiredate", "label": "Hired", "type": "range"},
            {"column": "rating", "type": "star", "max": 5}]}
```

| Key | Meaning |
|---|---|
| `report` | The id of the report region to filter |
| `search` | `true`: a search field at the top |
| `facets[].column` | A column of the report's SELECT |
| `facets[].label` | Heading (default: the column name) |
| `facets[].type` | `checkbox` (default), `range` or `star` |
| `facets[].limit` | checkbox: most frequent values shown (default 12, max 50) |
| `facets[].exclude` | checkbox: `true` lets users exclude the chosen values |
| `facets[].ranges` | range: `[{"from": …, "to": …, "label": …}]`, numbers or `YYYY-MM-DD` dates; either bound may be left out (at most 20) |
| `facets[].custom` | range: `true` adds *from*/*to* fields (default: only when there are no `ranges`) |
| `facets[].max` | star: the highest rating, 2–10 (default 5) |

Only filters that a facet on the page allows are read from the URL: a value for a column without a
facet, a range that isn't one of the facet's own, or a *from*/*to* on a facet without `custom`
is ignored. Values and bounds are sent as query parameters, never as SQL text. A range facet on a
column that is neither a number nor a date shows a message instead.

Typical layout: facets region with `columns: 3` and template `collapsible`, report with
`columns: 9`. On phones the facets stack above the report. Without JavaScript an *Apply* button
submits the panel; with JavaScript every change applies at once.

---

### `smart_filters`

The compact alternative to a facets panel (APEX *smart filters*): one search field above a report,
with the filters in use as **chips** (each with a × to remove it) and **suggestions** below it.
Without a search term the suggestions are each facet's most frequent values (or its ranges); while
the user types they are the values that contain the term, and choosing one replaces the term by
that filter. If nothing matches, the term searches all columns of the report.

```json
{"report": 57,
 "placeholder": "Search or filter employees…",
 "suggestions": 3,
 "facets": [{"column": "job", "label": "Job"},
            {"column": "department"},
            {"column": "sal", "label": "Salary", "type": "range",
             "ranges": [{"to": 1500}, {"from": 1500, "to": 3000}, {"from": 3000}]}]}
```

| Key | Meaning |
|---|---|
| `report` | The id of the report region to filter |
| `facets` | As for [`facets`](#facets-faceted-search) (checkbox, range and star; `exclude` and `custom` are for the facets panel) |
| `suggestions` | Suggestions per facet, 0–10 (default 3) |
| `placeholder` | The text in the empty search field (translatable) |

Everything is a link or a GET form on the report's own URL parameters, so it works without
JavaScript, can be bookmarked and is kept in saved reports. A facets panel and smart filters may
filter the same report; the first definition of a column on the page wins. Give the region
template `plain` and `columns: 12` above the report.

---

### `display_selector` (region display selector)

A bar of **tabs** (or a **select list**) that shows one region of the page at a time, like APEX's
region display selector. Regions take part through their own attributes:

- `"display_selector": true`: a tab named after the region's title;
- `"display_selector": "Tab name"`: regions with the same name share one tab (e.g. a smart filters
  region and its report). The name is translatable.

```json
{"style": "tabs", "show_all": true, "remember": true}
```

| Key | Meaning |
|---|---|
| `style` | `tabs` (default) or `select` |
| `show_all` | `false` hides the *Show all* tab (default: shown) |
| `remember` | `false`: don't remember the chosen tab for the browser session (default: remembered per page) |

Regions stay where the page puts them; regions hidden by a condition or authorization get no tab.
Without JavaScript the bar is a list of links to the regions (`#R<id>`) and every region shows.
With JavaScript the links become accessible tabs (arrow keys, Home and End), the other regions are
hidden, and a link to `#R<id>` opens the tab of that region. In the page designer the display
selector's settings list the page's regions with a checkbox and a tab name each.

The HR example's page 21 (*Explore*, `examples/hr/hr_21_regions.sql`) has a display selector with
three tabs: smart filters over an employee report, a faceted search with a search field, an
excludable job facet, salary ranges with from/to, a hire date range and a star rating, and a chart.

---

### `map`

**Source**: a SELECT with one row per place. The position comes from `lat` and `lng` (or
`latitude`/`longitude`), or from a `location` column holding `latitude,longitude` text (what a
[`location` item](05-items.md) stores). Optional columns: `title` and `body` (the popup), and
`geojson` (a GeoJSON geometry or feature, e.g. PostGIS `st_asgeojson(geom)`) to draw lines and areas.

```sql
select dname as title, initcap(loc) as body, lat, lng, deptno
  from hr.dept where lat is not null
```

The map zooms to fit all places. Attributes:

| Key | Meaning |
|---|---|
| `link` | `{"page": 5, "items": {"P5_DEPTNO": "#deptno#"}}`: the popup links there (only when the user may open that page) |
| `height` | `small`, `medium` (default) or `large` |
| `zoom` | Zoom level (1–19) when there is one place; default 14 |
| `empty` | Text when no row has a position |
| `layer` | `markers` (default) or `heat`: a heat map of the places, each weighted by its `weight` column (default 1) |
| `report` | The id of a report region on the same page that the map filters (below) |

**Heat map.** With `"layer": "heat"` the places are drawn as a heat map instead of markers: where
places (or heavier weights) are close together, the colour is darker. It suits many points, such as
visits, incidents or sales. A legend (fewer → more) sits in the corner. GeoJSON shapes are still drawn.

```sql
select lat, lng, sal as weight from hr.emp join hr.dept using (deptno)   -- {"layer": "heat"}
```

**Filtering a report by the map area** (APEX: map as a spatial filter). Give the map
`"report": <region id>` of an [interactive report](#report-interactive-report) on the same page.
When the user moves or zooms the map, a **Show this area in the list** button appears. It reloads
the page with the report showing only the rows in the map's visible area, with a removable
**Map area** chip and a **Show everything** button on the map. The report needs position columns
like a map's (`lat`/`lng`, `latitude`/`longitude` or `location`). Without them the chip is marked
and nothing is filtered. The area is in the URL (`r<id>_bb=south,west,north,east`), so it can be
bookmarked and saved with a saved report. It also applies to the report's downloads. The HR example's
page 16 (Locations) has a heat map of the payroll and an offices map that filters the employee list.

Below the map a collapsed list names every place, so the data is reachable without JavaScript and
by screen readers. The map uses [Leaflet](https://leafletjs.com) (shipped with pgapex, loaded only
on pages with a map) and tiles from OpenStreetMap. Their [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
suits light use; for production set `MAP_TILE_URL` (and `MAP_ATTRIBUTION`) to your own or a
commercial tile server, e.g. `https://tiles.example.com/{z}/{x}/{y}.png`. The Content-Security-Policy
allows images from that server only.

### `tree`

**Source**: a SELECT returning `id`, `parent_id` and `label`, and optionally `icon` (an icon name).
Rows whose parent isn't in the result are the top level; no recursive query is needed.

```sql
select empno as id, mgr as parent_id, initcap(ename) || ' · ' || initcap(job) as label
  from hr.emp
```

Attributes: `expanded` (levels open at first, default 1), `link` (as for maps; `#id#` and any other
column), `empty`. The tree is drawn on the server with `<details>`: it works without JavaScript,
and the browser's find-in-page opens closed branches. Clicking a label follows the link; the rest
of the row opens and closes the branch. Up to 5000 nodes.

### Template components

A **template component** (APEX 23.1+) is a piece of HTML with placeholders, kept under **Shared
Components → Template components** and used in two places:

- as a region of type **`template_component`**: one instance per row of the region's query (or once,
  without a query), or all rows inside the component's *wrapper*;
- as a **column template** of a report: the cells of one column are drawn by the component.

A component has a **static id** (e.g. `status_badge`; regions and columns refer to it by this id),
a name, a version, the **template** of one instance, an optional **wrapper**, **layout classes**
and **custom attributes**.

#### The template language

```html
<span class="tc-badge tc-badge-{case STATE/}{when ok,approved/}success{when late/}danger{otherwise/}neutral{endcase/}">#LABEL#</span>
```

| Syntax | Meaning |
|---|---|
| `#NAME#` | a custom attribute, a column of the row, `#LINK#`, `#APEX$ROW_NUM#` (and in a wrapper `#APEX$ROW_COUNT#`). **Always HTML-escaped**; there is no raw form (`#NAME!RAW#` is refused) |
| `#NAME!STRIPHTML#` | the value with tags removed, then escaped |
| `{if NAME/}…{elsif ?NAME/}…{else/}…{endif/}` | `NAME`: true (not empty, not `N`/`no`/`false`); `?NAME`: not empty; `!NAME`: not true |
| `{case NAME/}{when a/}…{when b,c/}…{otherwise/}…{endcase/}` | compare a value (ignoring case) with one or more values |
| `{loop "," NAME/}#APEX$ITEM# #APEX$I#{endloop/}` | each part of a value split on a separator (default `:`) |
| `#APEX$ROWS#` | in the wrapper only, exactly once: where the rows go |

Templates may come from plug-in files someone else wrote, so they are held to more than "developer
HTML is trusted". When a template is saved, imported and rendered, pgapex checks it against an
allow-list:

- only ordinary content elements (`div`, `span`, `p`, `a`, `img`, `ul`, `table`, `time`, …): no
  `<script>`, `<style>`, forms, frames, `<svg>` or comments;
- no event handler (`on…`), `style` or `data-*` attributes; every attribute value is quoted;
- placeholders and directives only in text or inside a quoted attribute value, and a directive block
  starts and ends in the same place, so leaving a branch out never leaves half a tag;
- `href`, `src` and `cite` allow only http(s), `mailto:`, `tel:` and relative URLs. They are checked
  again *after* substitution: a value like `javascript:alert(1)` drops the attribute.

So whatever the data, the page gets exactly the template's elements and attributes. For links to
pages of the application use `#LINK#`: pgapex fills it with a checksummed URL (and opens modal
pages as a dialog). The look comes from classes (the Content-Security-Policy blocks inline styles):
`tc-badge` (`-success`, `-warning`, `-danger`, `-info`, `-neutral`), `tc-card`, `tc-card-head`,
`tc-avatar`, `tc-title`, `tc-meta`, `tc-body`, `tc-actions`, `tc-stack`, `tc-row`, `tc-muted`,
`tc-timeline`, `tc-timeline-item` (`tc-state-success`, …), plus everything else in `app.css`.

**Layout classes** set how a region lays out the instances: `tc-list` (default, one below the
other), `tc-grid` (responsive columns), `tc-inline` (in a line), `tc-divided` (with rules),
`tc-compact`.

**Custom attributes** (JSON) are the component's settings, filled in where it is used:

```json
[{"name": "LABEL", "label": "Label", "type": "text", "default": "#STATUS#"},
 {"name": "STATE", "type": "select", "options": ["ok", "late", "other"]},
 {"name": "COMPACT", "type": "checkbox"}]
```

Types: `text`, `number`, `select` (with `options`), `checkbox` (`Y`/`N`). A value (or default) may
contain `#column#` and `&ITEM.` substitutions, so `"default": "#STATUS#"` makes the component
work on any query with a `status` column. `LINK` is reserved.

The component's page in the builder shows its attributes, the columns it expects and a **preview**
with sample rows (`NAME=value` per line, a blank line between rows).

#### As a region

Choose **Type** `template_component` and a **Source** SELECT (or none, for one instance from the
attributes). Under the region, **Template component settings** writes its `config`:

```json
{"component": "contact_card",
 "attributes": {"SUBTITLE": "#job#"},
 "display": "multiple",
 "link": {"page": 3, "items": {"P3_EMPNO": "#empno#"}},
 "max_rows": 50, "empty": "No colleagues yet"}
```

`display`: `each` (default) or `multiple` (all rows in the component's wrapper, e.g. one
`<ol class="tc-timeline">`). `link` fills `#LINK#` (empty for users who may not open the page).
At most 500 rows.

#### As a report column template

Under a report region, **Column templates** picks a component per column, with attribute values
(`NAME=value` per line). The template sees every column of the row as `#NAME#` (also hidden ones),
and `#LINK#` is the report's link. Stored in the region's `config`:

```json
{"column_templates": {"status": {"component": "status_badge", "attributes": {"STATE": "#status#"}}}}
```

Column templates apply to the report view (not to downloads, which keep the plain value).

#### Plug-ins

A component travels as one JSON **plug-in file** (`"format": "pgapex-plugin/1"`, `"type":
"template_component"`): **Download plug-in file** on its page, and **Import a plug-in** under
Shared Components → Template components → Add (optionally replacing a component with the same
static id). The template is checked before anything is saved. In SQL:

```sql
select meta.export_template_component(<app id>, 'status_badge');
select meta.import_template_component(<app id>, '<plug-in json>'::jsonb, p_replace => false);
```

`examples/plugins/` has three to start from: `status-badge`, `contact-card` and `timeline-item`.
The HR example installs them (`examples/hr/hr_19_template_components.sql`): page 19 (Team) shows
contact cards linking to the employee form, recent hires on a timeline, and leave requests with a
status badge. Template components are part of an application export (`template_components`).

### `static` and `dynamic` content

- **`static`**: `source` is HTML written by the developer, with `&ITEM.` substitutions
  (HTML-escaped). Items placed in the region are rendered below the HTML.
- **`dynamic`**: `source` is a SELECT; the first column of each row is output as HTML, like APEX's
  "PL/SQL Dynamic Content". The SQL is trusted, so **escape data** with `meta.html_escape()`:

```sql
select '<ul>' || string_agg('<li>' || meta.html_escape(ename) || '</li>', '') || '</ul>'
  from hr.emp where job = 'MANAGER'
```

A dynamic region outputs at most `max_rows` rows (default 1000).

The content security policy blocks inline `<script>`, event handler attributes, `style="…"`
attributes and `<style>` blocks in both: use the classes of `/static/app.css` (for example
`muted`, `lead`, `alert alert-success`, `tag`, `btn`, `cards`/`card`) instead. A browser ignores
blocked styles and reports them in its developer console.

## Large tables

pgapex is meant for tables of any size. Reports and grids page in the database (`limit` /
`offset`), so only one page of rows reaches the server; the settings below keep the rest of the
page fast too. The HR example's page 25 (*Large tables*, `examples/hr/hr_25_large_tables.sql`)
shows them on 200,000 generated rows.

**Pagination.** By default a report shows "1–15 of 2,345", which counts every row the search and
filters leave. On a large table that count reads the whole result. With
`"pagination": "range"` (page designer → Report settings → *Pagination*: *Row ranges*) the
report shows "Rows 1–15" and reads one row more than it shows to know whether there is a next
page, like APEX's "row ranges X to Y" pagination. Grids take the same setting.

**Keyset paging.** An offset still makes the database read and skip every row before the page,
so page 8,000 is slower than page 1. A row-range report with `"keyset": ["id"]` (Report settings →
*Keyset columns*: columns that make a row unique and are not null, ideally the primary key) pages
by position instead ("seek" paging): the report is ordered by the user's sort column (if any) and
then the keyset columns, and *Next* and *Previous* carry the last or first row's values in a
signed URL parameter (`r<id>_k`). The next page is `where (id) > ($1) order by id limit 16`,
which an index answers directly, however deep the page, and rows added or removed meanwhile
don't shift the pages. The values are always query parameters; a position that is not signed by
the server for this region, sort and page, is too large, or doesn't fit the column's type is
ignored, and the report pages with the offset as before. Offset paging is also used without a
position (a page number typed in the URL), for a control break, or in the group by, pivot and
chart views. Search, filters and sorting work as usual: a new sort or filter starts on page 1.

**Maximum row count.** `"max_rows": 10000` caps what a report reads: its total is counted over at
most 10,001 rows ("1–15 of more than 10000"), the pager stops at the last page within the
maximum, and the downloads hold at most that many rows. Page numbers beyond it show the last
page; the server also limits page numbers (1,000,000) and page sizes (500, grids 200), whatever
the URL says.

**Row limits.** Regions without paging read at most `max_rows` rows:

| Region | Default | When cut off |
|---|---|---|
| `cards` | 500 | "Showing the first 500 rows." |
| `chart` | 1000 | the same note under the chart |
| `dynamic` | 1000 | |
| lists of values (an item's `max_rows`) | 5000 | (up to 50,000) |

Calendars (2,000 events), maps (5,000 places) and trees have their own limits.

**Lazy loading.** `"lazy": true` (report, chart, cards, dynamic, tree and template component
regions) sends the page with a placeholder; the browser then fetches the region from
`GET /a/<alias>/<page>/region/<id>` (with the page's query string, so paging and filters apply)
and puts it in place. One slow chart no longer delays the whole page. The request is checked like
the page: the session, page access, and the region's condition and authorization scheme. Without
JavaScript the placeholder is a link that shows the page with the region in it (`r<id>_load=1`).

**Region caching.** `"cache": {"scope": "user", "seconds": 300}` keeps the region's rendered HTML
in the server's memory for 1 second to 1 day (same region types as lazy loading):

| Scope | Shared by |
|---|---|
| `session` | one session |
| `user` | the user's sessions |
| `all` | all users with the same roles |

The cache key also holds the application, page, region definition, language, the request's query
string and the values of the items the region refers to (and of its own items), so a region is
never shared across applications, and a changed region or item value renders anew. A **submit of
the page** empties its cached regions; a dynamic action's *Refresh region* renders the region anew.
Regions whose links carry per-user checksums are not cached for all users, the session's CSRF
token is never cached, and a region that shows an error is not cached. A lazy region that is in
the cache shows at once. Each server process has its own cache: `REGION_CACHE_MAX_ENTRIES`
(default 1000) and `REGION_CACHE_MAX_MB` (default 64) bound it, and one region over 2 MB is
not cached. Use it for regions that are expensive and may be a little old (dashboards, summaries).

