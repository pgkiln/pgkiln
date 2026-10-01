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
| [`chart`](#chart) | Bar, column, stacked, line, area, combo, scatter, donut or pie chart from a SELECT |
| [`cards`](#cards) | Cards or KPI tiles from a SELECT |
| [`calendar`](#calendar) | Month calendar of dated rows |
| [`facets`](#facets-faceted-search) | Checkbox filters with counts for a report |
| [`map`](#map) | Places (markers) and shapes on an interactive map |
| [`tree`](#tree) | Rows with a parent as an expandable tree |
| [`tasks`](06-processing.md#approvals-and-the-task-list) | Task list: approvals and actions for the signed-in user |
| [`workflows`](06-processing.md#workflows) | Workflow console: the workflows the user started or administers |
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
| `saved_reports` | `true` | `false` hides saved reports for this report |
| `public_reports` | none | Authorization scheme whose users may save public reports |
| `pdf` | none | PDF layout, columns and widths; see [report layouts](16-files.md#report-layouts) |
| `selection` | none | Row selection: `{"column": "empno", "item": "P2_SELECTED"}` (see [row selection](#row-selection)) |

Items placed **in** a report region appear in its toolbar; that's how filter fields (for example
a department select list with `submit_on_change`) are made.

The CSV and Excel downloads use the current search, filters and sort, grouped by the control
break column when there is one (up to 100,000 rows). Text cells that start with `=`, `+`, `-` or
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

Attributes: `{"kind": "bar" | "column" | "stacked" | "line" | "area" | "combo" | "scatter" | "donut" | "pie"}`
(default `bar`).

| Kind | Best for | Notes |
|---|---|---|
| `bar` | ranking categories with long labels | horizontal bars, values at the tips |
| `column` | comparing a few categories or series | values on the caps for ≤ 12 categories |
| `stacked` | parts of a total per category | one column per label with the series stacked on top of each other; negative values stack downwards |
| `line` / `area` | change over time | label column should be ordered (dates, years) |
| `combo` | two measures with one shared label | the **first series is drawn as columns**, the other series as lines over them |
| `scatter` | the relation between two numbers | the **first column must be numeric** (the x axis); each further column is a y value. Rows with an empty or non-numeric x are left out. The axes don't have to start at zero |
| `donut` / `pie` | parts of a whole (≤ 6 slices) | uses the first series; more than 6 slices fold into "Other"; zero and negative values are left out. The donut shows the total in the middle |

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

### `static` and `dynamic` content

- **`static`**: `source` is HTML written by the developer, with `&ITEM.` substitutions
  (HTML-escaped). Items placed in the region are rendered below the HTML.
- **`dynamic`**: `source` is a SELECT; the first column of each row is output as HTML, like APEX's
  "PL/SQL Dynamic Content". The SQL is trusted, so **escape data** with `meta.html_escape()`:

```sql
select '<ul>' || string_agg('<li>' || meta.html_escape(ename) || '</li>', '') || '</ul>'
  from hr.emp where job = 'MANAGER'
```

The content security policy blocks inline `<script>`, event handler attributes, `style="…"`
attributes and `<style>` blocks in both: use the classes of `/static/app.css` (for example
`muted`, `lead`, `alert alert-success`, `tag`, `btn`, `cards`/`card`) instead. A browser ignores
blocked styles and reports them in its developer console.
