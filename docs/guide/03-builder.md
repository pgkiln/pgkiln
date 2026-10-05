# 3. Using the builder

The builder lives at `/builder`. Everything it does is also possible in SQL (see
[the reference](09-reference.md)); the builder just makes it quicker.

## Signing in and developer accounts

Sign in with a developer account. The first one is `admin` / `admin`, and a red banner reminds you
to change it. On the **Developers** page you can:

- change your own password (minimum 8 characters; other builder sessions of yours end);
- as an **administrator**: add developer accounts (developers or administrators), make a developer
  an administrator or the other way round, and remove other developers (their sessions end
  immediately).

All developers have full rights in the builder and the SQL Workshop; administrators also manage
developer accounts and can break other developers' [locks](#page-locks-and-comments). Accounts
that existed before 0.23 and those made with the command line are administrators.

## The builder window

Every builder page has the same frame, modelled on an IDE:

- **The icon rail** on the left: App Builder, SQL Workshop, Users, Developers, **Search** (on the
  pages of an application), Help, and your account menu (the circle with your initials) with the
  **builder theme** (*Dark*, the default; *Light*; or *System*, which follows the operating system),
  Change password and Sign out. The theme is remembered on this device, also after signing out;
  it only changes the builder, not your applications.
- **The toolbar** at the top: a back button, the breadcrumb and, in the page designer, the page
  tools.
- The pages of an application have tabs under its name: Pages, Shared Components, Activity, REST
  API, Settings, Search and Advisor, with Export and Run on the right.

- **The status bar** at the bottom: who is signed in, the database, the builder's language and
  the pgapex version.

On phones the rail gets narrower and the breadcrumb shows only the current page.

## App Builder home

The home page is laid out like APEX's App Builder:

- **Four tiles**: **Create** and **Import** (each on its own page), the workspace **Dashboard**
  (applications, pages, active accounts; page views, users, failed sign-ins and errors of the last
  24 hours, and per application the last 7 days with a link to its Activity page) and
  **Workspace Utilities** (users, identity providers, LDAP directories, password policy,
  developers, the SQL Workshop, and for administrators the [installation log](#installation)).
- **The applications**, as a report (application id, name, alias, pages, page views of the last 24
  hours, sign-in, last updated, and Edit / Run) or as cards. **Search** filters the list as you type
  (by name, alias or id; without JavaScript, press Enter). Click a column heading, or use
  **Actions**, to sort. The view and the sort are remembered until you sign out.
- **A side column** (on the right on wide screens, below the list otherwise): About, **Recent** (the
  applications you opened last) and Tasks.

### Creating an application

**Create** (a tile, or `/builder/create`):

| Field | Meaning |
|---|---|
| Name | Display name, shown in the header |
| Alias | Lowercase URL name: `inventory` gives `/a/inventory` |
| Parsing schema | The database schema the app works with. Choose an existing schema, or leave it on "new schema" to create one named after the alias |
| Authentication | *App users* (a login page and a user list), *HTTP header* (a trusted reverse proxy names the user, see [chapter 8](08-security.md#http-header-authentication-reverse-proxy)), *Database accounts* (PostgreSQL login roles and their passwords, see [chapter 8](08-security.md#database-accounts-postgresql-roles)), *Custom* (your own PL/pgSQL function, see [chapter 8](08-security.md#custom-authentication-a-plpgsql-function)) or *None* (a public app) |
| First user / Password | The first user; they get the `admin` role. An existing account is reused (its password isn't changed) |
| Start from | Shown when there are **boilerplate** applications (Settings → Application type): their pages, shared components and settings are copied into the new application, which keeps its own name, alias, role and authentication ([application types](#application-types-and-subscriptions)) |

Creating the app also:

- creates the database role `app_<alias>` with `SELECT/INSERT/UPDATE/DELETE` on all tables,
  `USAGE` on sequences and `EXECUTE` on functions in the schema, plus **default privileges**,
  so tables you create later (as the owner, e.g. in the SQL Workshop) are usable by the app straight away;
- creates page 1 *Home*, a navigation entry, and an authorization scheme `ADMIN` (role `admin`).

The parsing schema can't be `meta`, `information_schema` or a `pg_*` schema.

### Creating an application from a file

**Create → From a file** (`/builder/create/file`, APEX: *Create App from a File*) starts an
application from a spreadsheet:

1. **Upload** a CSV or TSV file (UTF-8 or Windows-1252; the delimiter is detected), an Excel `.xlsx`
   file (every sheet with rows becomes a table, see [several sheets](#several-sheets-or-tables-in-one-file)),
   JSON (an array of objects; an object with several arrays becomes several tables) or XML, up to `DATA_LOAD_MAX_MB` (50 MB) and
   `DATA_LOAD_MAX_ROWS` (100,000 rows). Untick *First row contains column names* when it doesn't.
2. **Check the proposal**: a preview of the first rows; the application's name, alias, parsing schema,
   authentication and first user (as for a blank application); the table name (`employee_list.xlsx`
   → `employee_list`) and, per file column, a few sample values, the column name (`Hire Date` →
   `hire_date`; empty skips the column) and the type inferred from the values (text, integer, bigint,
   numeric, boolean, date, timestamp: dates and timestamps in ISO format). Choose the pages:
   - always: page 2, an interactive report of the table, with a modal form (page 3) to create, change
     and delete rows;
   - *Dashboard* (page 4): a bar chart with the number of rows per value of the first text, yes/no or
     date column whose values repeat (2 to 50 different values); left out when there is none;
   - *Faceted search* (page 5): a report with a filter panel: values with counts for repeating text
     and yes/no columns, ranges for numbers and dates, and a search field.
3. **Create application**: in one transaction, the schema and the role `app_<alias>` (as above), the
   table in the app's schema with an identity primary key `id`, the rows, and the pages (made with
   `meta.generate_page`, the [page wizards](#create-page-wizards)) with a navigation entry each. When a
   row doesn't fit its column's type, **nothing is created**: the form comes back with the failed
   rows (the first 100) and your choices; fix the types, or tick *Skip rows with errors* to load the
   others (the result page lists the skipped rows).

Everything is a plain form (no JavaScript needed). The file is kept as a temporary file of your
builder session between the steps; it is deleted when the application is created. To load more files
into the table later, use the SQL Workshop's [Load Data](16-files.md#sql-workshop--load-data) or a data load definition.

#### Several sheets or tables in one file

An Excel workbook with several sheets (empty sheets are left out; at most 20), or a JSON object with
several arrays of objects (`{"departments": [...], "employees": [...]}`), gives step 2 a section per
sheet:

- **Create a table from this sheet**: untick to leave the sheet out;
- **Table name** (from the sheet name: `Order Lines` → `order_lines`), and the column names and types as above;
- **Primary key**: a file column, or a new identity column `id`. Proposed: a column named `id`,
  `code`, `<table>_id`, `<table>_code` or `<table>_no` (singular or plural) with a value in every row,
  all different. A whole-number key becomes the table's identity key (new rows continue after the
  highest loaded value); another key (a text code) becomes `not null unique` next to a new `id`.
- **Foreign keys** (one list under the sheets): a column is proposed as a foreign key to another
  table's key when it is named like the key column (`dept_id` → `departments.dept_id`), like the
  other table and its key (`department_id` → `departments.id`, `project_code` → `projects.code`) or
  like the other table alone (`department`), with a compatible type. A proposal is ticked when every
  value is found in the other table, otherwise it shows how many rows don't match. Untick what you
  don't want. After changing table or column names or keys, press **Update the proposals**: the
  form is redrawn (nothing is created yet).

**Create application** then creates, in one transaction: the app, the tables, the rows, the foreign
keys (added after all rows are loaded, with an index on each foreign key column; a value that isn't
found stops everything with the row's key in the message), an interactive report with a modal form
per table (forms get a select list for each foreign key), a navigation entry per table, and with
*Dashboard* one page with a chart per table (at most six): the rows per parent row for a table with a
foreign key, otherwise per value of a column whose values repeat.

### Creating an application from pasted data

**Create → From pasted data** (`/builder/create/paste`, APEX: *Copy and Paste*): paste rows copied
from a spreadsheet (tab-separated) or CSV text (comma, semicolon or `|`; detected) into the text
area, give it a name (it proposes the application and table names) and press *Next*. The text is
kept as a temporary file of your builder session and takes the same steps as an uploaded file. At
most 4 MB of text; upload larger data as a file.

### Creating an application from existing tables

**Create → From existing tables** (`/builder/create/tables`): choose a schema (pgapex's `meta`,
`information_schema` and the `pg_*` schemas aren't offered), then tick its tables and views (tables
are ticked by default). The application gets that schema as its parsing schema and a role
`app_<alias>` with the grants of a blank application on the schema (so **all** tables of the schema,
not only the ticked ones). For each ticked table with a single-column primary key, an interactive
report with a modal form (`meta.generate_page` *report_form*); for views and tables without such a
key, a report page; a navigation entry each; and optionally a dashboard (a chart per table, as above;
for existing tables the repeating values come from the planner statistics, so `ANALYZE` a table that
was never analyzed). Everything is created in one transaction. Foreign keys to tables in another
schema show in forms as select lists that the app's role may not be allowed to read: grant it, or
pick a schema that holds them all.

### Importing

**Import** (a tile, or `/builder/import`): paste the JSON of an export and optionally give a new
alias. A directory export (one file per component) is imported with `pgapex import`
([chapter 18](18-cli.md)). Imported apps keep the database role
of the export; check it under **Settings**, and create users under **Shared Components**. An
application with [supporting objects](#supporting-objects) opens on their page after the import:
they are **not** run until you choose to.

## App dashboard

Open an application to see its pages, with region/item/dynamic-action/process counts,
authorization and protection. The tabs under its name lead to **Shared Components**, **Activity**,
**REST API**, **Settings**, **Search** and **Advisor**; **Export** and **Run** are on the right.

### Create pages from a table (wizards)

The wizards are two plain forms (they work without JavaScript). On the app's Pages tab, choose a
**page type** and a **table or view** (tables the app's database role can't read are marked) and
press **Next**. The second step proposes everything from the database catalog: the columns, the
primary key, date and number columns, positions and foreign keys. Change what you like, choose the
page number, name and menu icon, and press **Create page**: the builder opens the new page in the
page designer. An error (a page number in use, a column that doesn't fit) shows on the second
step, which keeps the table and type.

| Page type | What is generated | Proposed from the catalog |
|---|---|---|
| **Report and form** | An interactive report page listing the table (with an edit link per row and a Create button) and a **modal dialog** form page with Create, Apply Changes and Delete, a form DML process, fields per column (foreign keys become select lists, booleans become switches, NOT NULL columns without default become required) and a navigation entry | |
| **Interactive grid** | One page with an editable grid (foreign keys become select lists, NOT NULL columns become required), a grid DML process and a navigation entry | |
| **Form** | One form page (normal or modal) with the chosen columns, Cancel / Delete / Apply Changes / Create and a form DML process; the buttons return to a page you choose (default: the home page). No navigation entry unless you tick it | All columns except binary ones; NOT NULL columns without a default are always included |
| **Cards** | A [cards](04-pages-and-regions.md#cards) region with a title, subtitle, body and badge column | Title: a name, title or label column; subtitle: the first foreign key (showing the parent's name) or the next text column |
| **Calendar** | A [calendar](04-pages-and-regions.md#calendar) region (month, week, day and list views) | Start: a date or timestamp column named like *start*, *begin* or *…_date* (not *created*/*updated*); end: one named like *end* or *until*; title: a name column, else the first foreign key's name |
| **Chart** | A [chart](04-pages-and-regions.md#chart) region: bar, column, line, area, donut, pie or funnel of the row count, or the sum, average, minimum or maximum of a number column, per label | Label: the first foreign key (its parent's name), else a text column that isn't unique |
| **Map** | A [map](04-pages-and-regions.md#map) region with popups and, if ticked, an interactive report of the same rows that the map filters (*Show this area in the list*) | Position: a PostGIS geometry or geography (markers, and lines and areas as shapes), a `point`, `lat`/`lng`-like number columns, or a *location* text column with `latitude,longitude` |
| **Faceted search** | An interactive report (9 columns wide) and a [facets](04-pages-and-regions.md#facets-faceted-search) panel (3 columns, collapsible) with a search field | Up to six facets: foreign keys (values of the parent's name, which the report shows next to the key), booleans, text columns with few values, dates and numbers as ranges with *from*/*to* |
| **Master detail** | One page with a grid of the table and an editable grid of the selected row's details below it (the grids' [master-detail](04-pages-and-regions.md#grid-interactive-grid)): a hidden item for the selection, both grids with a grid DML process; new detail rows get the master's key | The detail table: a table with a foreign key to this table's primary key |

Cards, Calendar, Map and Faceted search take an optional **Form page** number: it adds a modal
form page for a row, a link from each card, event, popup or report row, and a **Create** button
(on a calendar also a **+** on every day and hour, with the start date filled in). A calendar can
also get **drag and drop**: an `UPDATE` of the start (and end) column as the app's role, so row
level security applies; set the region's `move_authz` to limit who may move events.

Report and form, Interactive grid, Form, a Form page and Master detail need a single-column
primary key; the other types also work on views. Make sure the app's database role has privileges
on the table (automatic for its own schema): the second step warns when it hasn't. The same
generators can be called from SQL with [`meta.generate_page`](09-reference.md#functions-for-developers-and-scripts).

### Create a blank page

Give a page number, name, mode (normal or modal dialog) and breadcrumb parent, then add
components in the page designer.

## The page designer

The page designer has three panes, as in APEX's Page Designer. From 1024 pixels wide they sit
side by side; on phones and portrait tablets they are tabs (**Tree**, **Layout**, **Properties**):
choosing a component opens the Properties tab.

- **Left: the component tree**, with four tabs:
  - **Rendering**: the page, *Pre-Rendering* (branches, computations and processes that run
    before the page is shown), the
    **Regions** with their items and buttons, and page-level items and buttons;
  - **Dynamic actions**, grouped by event (change, click, page load);
  - **Processing**: computations after submit, validations, processes and the branches (the
    [branch components](06-processing.md#branches) in sequence, then the buttons that go to
    another page);
  - **Shared components** the page can use (lists of values, authorization schemes, navigation,
    application items), linking to Shared Components.

  Icons show which components have an authorization scheme, a condition or a build option. Folders open and close
  with a click; with the keyboard, the arrow keys walk the tree (Left / Right close and open a
  folder), Enter opens a component.
- **Middle: the Layout**: the page's regions on the 12-column grid, each with its items and
  buttons, as they will be placed on the page; under it a **gallery** of region types, item types
  and button actions. The middle pane also has a **Page search** tab (searches the application)
  a **Lock and comments** tab ([below](#page-locks-and-comments)) and a **Help** tab (layout keys and the substitution cheat sheet). Zoom in, zoom out and
  maximize (hides the side panes) are above the layout.
- **Right: the property editor** for the selected component, grouped (Identification, Source,
  Layout, Security, …) with help text for each property. Type in **Filter** to show only the
  properties whose name contains the text (Escape clears it); click a group's name to fold it
  (remembered on this device).

The toolbar has the page switcher (previous, a list of all pages, next), **Undo** / **Redo** of
layout changes, the **Create** menu (region, item, button, dynamic action, computation, validation,
process, branch, or a new page), a **Utilities** menu (Advisor, search, shared components, all pages, export),
**Save** (saves the property editor; it is highlighted when there are unsaved changes) and **Run**
(opens the page in a new tab). Changes are live as soon as they are saved.

### Page locks and comments

APEX's page locks and developer comments, for teams. In the page designer's **Lock and comments**
tab a developer **locks** the page (with an optional note); on the application's page (**Pages**,
under the list) they can lock the **whole application**. While it is locked, other developers' changes
to it are refused (with a message, or `423` for JSON requests) and the designer says who locked it
and since when; the page list shows a lock column. Locking an application refuses changes to every
page, the settings, shared components and deleting it. Only the developer who locked it or an
**administrator** unlocks it; an administrator breaking another developer's lock is logged in the
activity log (`lock_broken`). Running the application, the SQL Workshop and the command line are
not affected.

**Comments** are notes for the team on a page or the application: any developer adds one, the
author or an administrator deletes it. The page list counts each page's comments. A page that gets
another number keeps its lock and comments. Locks and comments belong to this installation and
are not exported.

### Arranging the layout

Regions are placed in sequence order; a region's *column span* (1–12) sets its width, and a
region that no longer fits starts a new row.

- **Drag a region** by its header to another place, or drag its right edge to make it wider or
  narrower.
- **Drag an item or button** to another place in its region, to another region, or to *Page level*.
- **Drag an entry of the gallery** onto the layout to create that component there, with a working
  starting point (a sample query for reports, charts and cards; a name like `P5_NEW` for items);
  then set its properties on the right. Clicking a gallery entry instead opens the create form
  with that type filled in.
- **Without a mouse**: focus a component on the layout and press <kbd>Alt</kbd>+<kbd>↑</kbd> /
  <kbd>↓</kbd> to move it, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>→</kbd> to make a
  region narrower or wider. The **Arrange** bar above the properties does the same with buttons
  (move up, move down, narrower, wider, or move an item or button to another region); on phones and
  tablets this is the way to arrange things.
- **Undo** and **Redo** in the toolbar take back the last 20 layout changes on this page (moving
  and resizing; creating a component starts a new history).

Without JavaScript the panes are shown one under the other, every component is a link and the
Arrange buttons still work.

### The code editor

Every field that holds code (region sources, conditions, lists of values, validations,
processes, dynamic actions, the JSON attributes, document templates, workflow steps, REST
handlers, the SQL Workshop and the import box) opens in a small code editor:

- **Syntax highlighting** for SQL and PL/pgSQL (keywords, types, strings, comments, `:ITEM`
  binds, `&ITEM.` substitutions, `$$` bodies), JSON and HTML (tags, attributes, `&ITEM.` and
  `{{tags}}`). The language follows the component type: a `static` region's source is HTML, a
  `regex` validation is plain text, an `execute_sql` dynamic action is PL/pgSQL.
- **Line numbers**, the line and column of the cursor, and the **matching bracket** marked.
- **Tab / Shift+Tab** indent and outdent (the selected lines, too); **Enter** keeps the
  indentation and indents after `(`, `begin`, `loop`, `then`; brackets and quotes are closed for
  you and typing the closer steps over it. Press **Escape, then Tab** to move on to the next field.
- **Suggestions**: press **Ctrl+Space** (or the **Suggest** button on a touch screen), or just
  type: after `schema.` the schema's tables, after `alias.` or `table.` its columns, after `:` the
  page's items, the application items and built-ins like `APP_USER`, after `&` the same as
  substitutions. Tables named in `from`/`join` and their aliases put their columns first.
  **Up/Down** choose, **Enter** or **Tab** insert, **Escape** closes.
- **Check** plans the SQL like the [Advisor](#advisor) does, as the application's role
  (`explain`, rolled back, nothing runs), and shows the problem under the field.

Suggestions only list what the **application's database role** may use: schemas it has `usage`
on, tables, views and columns it has a privilege on, and functions it may execute (an
application without its own role uses the runtime connection's role). The SQL Workshop lists
what the owner connection sees. The list is cached for 30 seconds and refreshed when you run
something in the SQL Workshop.

The editor only decorates the normal text field: the form posts the same text as before, undo,
copy and paste work as usual, screen readers read the plain field (the suggestion list is
announced as you move through it), and without JavaScript you get the plain field.

**Report regions** also get a **Report settings** form on the property editor's **Attributes** tab
(the editor reopens the tab you used last), so the common
settings need no JSON: rows per page, search, Actions menu, sorting, saved and public reports,
and per column its heading, whether it's shown, whether it's printed and its PDF width, plus the
link column (page and items), row selection (value column and item) and the PDF layout. The columns are read from the region's query
(run with `limit 0` as the application's role and rolled back). Saving writes the region's
*Attributes (JSON)* and keeps any other keys there.

The other region types with settings get a similar form, under the same rules (defaults are left
out, other keys are kept, columns the query no longer returns stay listed so you can clear them):

| Region | Settings form |
|---|---|
| `grid` | Rows per page; whether users may add, change and delete rows; per column its heading, shown, read-only, required and "Edit as" (a shared list of values); aggregates in the footer, frozen columns, the Actions menu, saved and public grid reports, the row actions menu (edit link, duplicate, delete) and master-detail (the master's column and item, the detail's item and column) |
| `chart` | Chart type (also Gantt, pyramid and polar, with the columns each expects), the text when there are no rows, the gauge's range and thresholds, and the drill-down link (page and items, `#column#` and `#series#`); lists the query's columns |
| `cards` | Cards or KPI tiles, the text when there are no rows, and the link (page and items) |
| `calendar` | The views and the one shown first, the hours of the week and day views, the edit link of each event, the create-on-click link (`#start#`, `#end#`, `#date#`), and drag and drop (the SQL with `:EVENT_ID`, `:NEW_START`, `:NEW_END`, the key column, who may drag); warns when the query lacks `start_date` or `title` |
| `facets` | The report region it filters and a search field on/off; per column of that report: facet on/off, label, type (checkboxes, ranges, star rating), values shown, exclude, ranges (`..1000; 1000..3000 = Middle; 3000..`), from/to and order |
| `smart_filters` | The same per-column facets, the suggestions per facet and the search field's placeholder |
| `display_selector` | Tabs or a select list, "Show all", remember the choice; per other region of the page: in a tab and the tab name (saved in that region's settings) |
| `data_reporter` | Data sources (a table or view each: static id, label, description, offered columns with labels and format masks), who may share reports, rows per page ([Data Reporter](04-pages-and-regions.md#data_reporter-data-reporter)) |

Links, lists of values and the facets' report are checked when saving: a form can only point to
pages and shared lists of values of the same application, and to report regions on the same page.

Page properties:

| Property | Meaning |
|---|---|
| Page number, name, title | The title supports `&ITEM.` substitutions |
| Page mode | *Normal*, or *Modal dialog* (opens over the calling page) |
| Breadcrumb parent | Builds the breadcrumb trail (and the highlighted menu entry) |
| Requires authentication | Uncheck for public pages in an app with a login |
| Authorization scheme | Who may open the page |
| Page access protection | *Arguments must have checksum* (default): item values in the URL are only accepted from links pgapex generated. *Unrestricted*: anyone may set this page's items through the URL |

Chapters 4–7 describe every component type and property.

## Working copies

APEX's working copies: a second application to change in isolation, then merge back. On an
application's pages, **Working copies** (top right) lists its copies and **creates** one with a
name; the copy gets the alias `<alias>-<name>` and its own application id. It is the same
application, so it runs against the main application's schema, role and data, and the same users
may sign in to it. It runs no automations or REST synchronisations (the main application does);
web credentials keep working.

Change the copy like any application. Its **Compare and merge** page compares it with the main
application per **component**: the application settings, each shared component (a list of values,
an authorization scheme, a REST data source, …), the navigation menu, each page's settings and each
region, item, button, process and so on. A copy keeps the main application *as it was when the copy
was made* (or last refreshed or merged), so the page tells which side changed what:

| Result | Meaning |
|---|---|
| Copy | changed (added, deleted) only in the copy: the copy's version wins |
| Main | changed only in the main application: its version stays |
| Conflict | changed on both sides, differently: choose **Main** or **Copy** |

**Show** shows a component's differences (lines of the main application with `-`, of the copy with
`+`). Then:

- **Merge into …** writes the result into the main application *and* the copy;
- **Refresh the copy** writes it into the copy only, bringing the main application's changes in
  (conflicts are chosen the same way).

Both keep what belongs to the installation, like `pgapex import --replace`: users and access,
sessions, saved reports, running tasks and workflows, secrets of web credentials, and the main
application's automation and synchronisation switches (a new automation arrives switched off). A
merge is refused while another developer has locked the main application or a page the merge
changes, and when either side changed after the comparison was shown (compare again). If the
result is not consistent (for example an item kept from one side refers to a region the other side
renamed), nothing is written and the message names the problem. Merges and refreshes are logged in
the activity log (`working_copy`).

**Delete working copy** deletes the copy's application. Deleting the main application leaves its
copies as ordinary applications. Copies of copies are not possible, and working copies are not
exported.

## Shared components

Components used by the whole application:

| Component | Purpose |
|---|---|
| **Access control** | Who may sign in (only listed accounts, or any active account), which accounts have access with which roles, and which identity-provider groups map to which roles |
| **Navigation menu** | Menu entries: label, icon, target page, parent (for sub-menus), authorization |
| **Authorization schemes** | Named access rules, used by pages, regions, items, buttons, processes, dynamic actions and menu entries ([chapter 8](08-security.md)) |
| **Lists of values** | Reusable queries for select lists, referenced as `LOV:NAME` |
| **Application items** | Session variables not on any page, set only by server-side code |
| **Application processes** | Code that runs *after login* or *before every page* |
| **REST modules** | REST endpoints (method, path, SQL) served by pgapex, with an OpenAPI description ([chapter 13](13-rest-api.md#rest-modules-in-the-builder)) |
| **Workflows** | Multi-step processes of tasks, SQL, web service calls (invoke API), decisions, waits and parallel branches, with versions and a diagram ([chapter 6](06-processing.md#workflows)) |
| **Task definitions** | Approvals and action tasks: subject, owners, administrators, due date, the SQL that runs on completion ([chapter 6](06-processing.md#approvals-and-the-task-list)) |
| **Document templates** | Letters, invoices and other PDFs filled from a query ([chapter 16](16-files.md#document-templates)), with a preview |
| **Build options** | Include / exclude switches for features; pages and their components name one in their *Build option* property, and *Used in* lists them ([chapter 6](06-processing.md#build-options)) |
| **Web credentials** | How the application signs in to web services (basic, API key header, bearer token, OAuth2 client credentials); the secret is write-only and encrypted ([chapter 19](19-rest-data-sources.md#web-credentials)) |
| **REST data sources** | Web service endpoints whose JSON becomes rows for regions and lists of values, with a **Test** button and suggested columns ([chapter 19](19-rest-data-sources.md#rest-data-sources)) |
| **Template components** | HTML templates with placeholders and directives, used as a region type and as report column templates, with a preview; shared as plug-in files ([chapter 4](04-pages-and-regions.md#template-components)) |
| **Data load definitions** | A target table, file format (CSV, Excel, JSON, XML with its row element) and column mapping with transformations, for SQL Workshop → Load Data and the `data_load` process ([chapter 16](16-files.md#data-load-definitions)) |
| **Lists** | Named sets of links (static entries with nesting, badges, conditions and authorization, or a query) for list regions, the navigation menu and the navigation bar ([chapter 4](04-pages-and-regions.md#list-lists)) |
| **Supporting objects** | Install, upgrade and deinstall scripts that travel with the export ([below](#supporting-objects)) |

### Application types and subscriptions

APEX 26.1's theme, library and boilerplate applications, and subscribed shared components. Each
application has a **type** (Settings → Application type):

| Type | Meaning |
|---|---|
| Standard | An ordinary application |
| Theme application | Offers its theme (colours, navigation, light/dark settings and the Theme Roller's styles) and its template components to other applications |
| Library application | Offers its lists of values, authorization schemes, build options, template components and lists (with their entries) to other applications |
| Boilerplate application | A starting point: **Create** offers it under *Start from* |

**Shared Components → Subscriptions** subscribes the application to one of those components: it is
copied now (replacing a component with the same name) and remembered as a subscription. The page
lists the subscriptions with their state (*in sync*, or *differs* when the master or the copy
changed); **Refresh** (one, or all) copies the master's definition again, replacing changes made
here, and **Unsubscribe** keeps the component as it is but forgets where it came from. The
component's own page in Shared Components says where it comes from, with a Refresh button.

On a theme or library application the same page lists its **subscribers**, and **Publish**
refreshes every subscriber of a component at once (an application locked by another developer is
skipped and named in the message). Subscribing, refreshing and publishing are logged in the activity
log (`subscription`). A subscribed list of values that uses a REST data source needs a data source
with the same name in the subscribing application. Subscriptions are links between the
applications of this installation and are not exported (the type is).

### Supporting objects

APEX's *Supporting Objects*: SQL scripts that create, upgrade or remove what the application needs
in the database (tables, views, functions, grants, seed data). Add them under **Shared Components →
Supporting objects** with a name, a kind (*install*, *upgrade* or *deinstall*) and a sequence. They
are part of the export (section `supporting_scripts`, and `shared/supporting-objects/` in a
directory export), so an application can be moved with its database objects.

They **never run by themselves**, also not on import (the builder and `pgapex import` say how many
came along). **Review and run…** opens the *Supporting objects* page: it shows every script and
runs the scripts of one kind on request, in sequence, **as the application's database role**
(so they can only do what that role may: give it `CREATE` on its schema for an install script),
statement by statement in **one transaction**: the first error undoes the whole run. The page then
shows each statement with its result (up to 20 rows) or its error, and the activity log records the
run (`supporting_objects`). Statements may take up to 10 minutes each.

## Users (the user directory)

**Builder → Users** lists every account with the applications (and roles) it can use. Create
accounts here (a password is optional for single sign-on-only accounts). Open an account to edit
its name and e-mail, set or remove its password, deactivate or delete it, and grant, change or
revoke access per application. Password changes, deactivation and access changes end the
affected sessions. See [chapter 8](08-security.md#the-user-directory).

**Users → Identity providers** configures OpenID Connect and SAML providers for single sign-on, and **Users → LDAP directories** the LDAP servers passwords can be checked against. Identity providers: issuer,
client ID and secret, claims, automatic account creation. The page shows the redirect URI to
register at the provider, and has a *Test discovery* button. See
[chapter 8](08-security.md#single-sign-on-openid-connect).

## Settings

- **Application**: name, alias, home page.
- **Security**: authentication (*App users*, *HTTP header*, *Database accounts*, *Custom* or
  *None*), the database role, and **debug mode** (shows full database errors to users; development
  only). The state of the [debug messages](06-processing.md#debug-messages) is shown below it,
  with a link to set their level. **Custom authentication**: the function name, or the function body, and the
  post-authentication code ([chapter 8](08-security.md#custom-authentication-a-plpgsql-function)).
- **Sign-in methods**: username and password, and/or the identity providers to offer on the login page.
- **Theme**: accent colour, header colour, *side* or *top* navigation (on tablets and phones the
  menu is always a drawer), a [list](04-pages-and-regions.md#list-lists) as the navigation menu
  (instead of the navigation entries) and as the navigation bar (links in the header), the theme style (automatic, light or dark) and whether users may choose light or dark.
  **Theme Roller** opens the [style variants](14-globalization.md#style-variants-theme-roller): several
  saved styles (colours, font, font size, corners), the default one, and whether users may choose.
- **Globalization**: primary language, translated languages, how the language is chosen, date formats.
- **Security checklist**: whether the app has its own role, debug mode, debug messages, and pages without
  checksum protection or without authentication.
- **Delete application**: removes the definition (not your tables).

**Progressive Web App** (in Settings): installable, offline pages, forms sent offline, the icon ([chapter 17](17-mobile.md)).

## Search and "Used in"

**Search** (in the application's header) looks through every page and component of the
application: names, titles, SQL, conditions, settings JSON and help texts, case-insensitively,
grouped by component type with the matching text marked. Each result links to the component.

Under an **item**, **page**, **list of values**, **list**, **authorization scheme** or **report layout**, a
**Used in** list shows the components that refer to it:

| Target | Found as |
|---|---|
| Item (page or application item) | the name as a whole word: `:P3_ID`, `&P3_ID.`, `"P3_ID"` in links and settings, `v('P3_ID')` |
| List of values | `LOV:NAME` in items and grid columns |
| Authorization scheme | Authorization fields (also negated, `!NAME`) and `"public_reports"` |
| Page | target pages, breadcrumb parents, navigation, `"page": n` in links, `meta.page_url(n, …)` |
| Report layout | `"layout": "NAME"` in report settings |
| List | `"list": "NAME"` in list regions (its entries are listed under the list itself) |

Database code (views, functions, RLS policies) isn't part of the application, so it isn't searched.

## Advisor

**Advisor** (in the application's header) checks the application without running it:

- **SQL:** every region source, list of values, condition, validation, process, computation,
  branch condition, button badge query, dynamic action,
  authorization scheme, application process and automation is planned with `EXPLAIN` as the
  application's database role, with binds as NULL, in a transaction that is rolled back. That
  finds syntax errors, unknown tables, columns and functions, type errors and missing grants.
  `DO` blocks are compiled into a temporary function (syntax). Statements that can't be planned
  without running them (`notify`, `call`, `set`, …) are listed as notes.
- **References:** pages, items, lists of values, authorization schemes, report layouts and
  regions that a component names but that don't exist (also build options, which leave the
  component out, and the items computations set or copy); grids without a key or a save process;
  workflow `invoke_api` steps that name a REST data source, parameter or web credential that
  doesn't exist, leave a required parameter empty or use a `&VAR.` no step sets.
- **PL/pgSQL functions:** when the `plpgsql_check` extension is installed, the functions in the
  schemas the application's role can use are checked with `plpgsql_check_function_tb` (see
  [extensions](15-extensions.md)).

Findings are errors, warnings or notes, each linking to the component.

## Activity monitor

Per application: page views, distinct users and average page time over the last 24 hours;
failed and locked sign-ins; errors and access denials; views and timings per page over 7 days;
and a list of recent events (with *Include page views*). The "reference #123" numbers users see
on errors are the event ids here.

**Debug messages** (APEX: *View Debug*) sets the application's debug level and retention and lists
the requests recorded while it was on: time, page, method and path, user, HTTP status, total time,
number of entries and problems (errors and warnings), filtered by page, user or *only with errors or
warnings*, 50 at a time. Opening one shows its entries with the time since the start of the request,
the duration of timed steps (the slowest is highlighted), the time until the next entry, level,
component and message, with links to the previous and next request. *Delete all debug messages*
empties the list. See [chapter 6](06-processing.md#debug-messages).

**Top SQL** lists the statements the application's database role ran, from `pg_stat_statements`:
calls, total and mean time, rows and share of the total, sortable, with *Reset the statistics*.
Literals appear as `$1`, `$2`…; applications that share a database role share the list. It needs
the server to load the module (`shared_preload_libraries = 'pg_stat_statements'`, set by the
development `docker-compose.yml`) and the extension, which migration 016 creates when it can (as
a superuser; otherwise `create extension pg_stat_statements;` by hand). Reading other roles' query
texts needs `pg_read_all_stats` for the owner role, and resetting needs execute on
`pg_stat_statements_reset`.


## Installation

Workspace utilities → **Installation** (administrators only; APEX: the install/upgrade logs of
instance administration) shows the pgapex version of the running server, the number of applied
migrations and the database, and warns when the database misses migrations of this server (run
`npm run db:migrate`) or has migrations the server does not know (an older server). Below it:

- **Install and upgrade runs**: every run of `npm run db:migrate` / `pgapex migrate` that applied a
  file or failed: when, *install* (an empty database) or *upgrade*, the version, the files and, for a
  failed run, the file and the error (that file was rolled back). Runs are recorded from 0.25 on.
- **Applied migrations** with the time each was applied, and the **example and seed scripts**.

## Globalization

**Shared Components → Globalization** translates the application's texts per language, exports and
imports XLIFF or CSV for translators, and manages text messages. See [chapter 14](14-globalization.md).

## REST API

Per application: the **API database role** that REST API tokens use, whether PostgREST answers
at `API_URL`, the endpoints (views and functions in the `api` schema, with the methods the role
may use), a form to **issue a token** for an account, and `curl` examples. See
[chapter 13](13-rest-api.md).

## SQL Workshop

- **SQL Commands**: run any SQL as the **owner connection**, not as an application role. Multiple
  statements are allowed; the result of the last one is shown (up to 500 rows). Press
  **Ctrl/Cmd + Enter** to run. The [code editor](#the-code-editor) suggests every schema, table,
  column and function the owner sees.
- **Object Browser**: tables, views and functions per schema. For a table you see columns, types
  and defaults, **row level security policies**, **grants** and the first 25 rows; for a
  function, its source.
- **SQL Scripts**: saved scripts, shared by all developers. Create one in the editor, upload a
  `.sql` file (UTF-8, up to 5 MB) or save one from Quick SQL; download it again as `.sql`. **Run**
  splits the script into statements at semicolons (outside strings, comments, quoted identifiers,
  `$$` bodies and `BEGIN ATOMIC … END`) and runs them one after another, with a **result per
  statement**: OK or the error, the command and row count, the time, and the first 10 rows of a
  query. Choose what happens when a statement fails: **stop** the script or **continue** with the
  next one. With **Run in one transaction**, *stop* rolls the whole script back and *continue*
  keeps the statements that worked (each runs in a savepoint). psql meta-commands (`\set`, `\i`,
  `\connect`) are reported as skipped. Every run is kept in the **run history** (the last 500
  runs), per script and overall, and in the activity log (`sql_script`). A script runs on a
  connection of its own that is closed afterwards, so `SET ROLE` or `SET search_path` in a script
  doesn't leak into other requests.
- **Quick SQL**: write tables in a shorthand and get the PostgreSQL DDL; save it as a script or
  run it. A table name on its own line with its columns indented below it; a table indented under
  another becomes a child table with a foreign key `<parent>_id`. Types follow the column name
  (`*_id` bigint, `*_at` timestamptz, `*_on`/`*_date` date, `is_*` boolean, `price`/`amount`
  numeric, otherwise text) or are written after it (`vc200`, `num(10,2)`, `int`, `date`, `tstz`,
  `json`, `bool`, `uuid` …). Column directives: `/nn`, `/pk`, `/unique`, `/idx`, `/fk table`,
  `/check a, b`, `/between 1 and 10`, `/default value`, `/lower`, `/upper`, `[a comment]`; table
  directive `/auditcols` (created/updated columns with a trigger). Settings: `# pk: identity | seq
  | guid | none`, `# schema: name`, `# prefix: xx`, `# drop: true`, `# auditcols: true`. `view name
  t1 t2` creates a view joining the tables by their foreign keys. Names become valid identifiers
  and values literals, so the DDL is always well-formed; problems are listed with line numbers.
- **Query Builder**: choose a schema and its tables and views; joins follow the **foreign keys**
  (inner or left; tables without one are cross joined, with a note). Pick the columns, conditions
  (`=`, `<>`, `<`, `like`, `in (a, b)`, `is null` …, combined with AND or OR), the sort, `distinct`
  and a row limit. The SELECT is shown and opens in SQL Commands. The state is in the URL, so a
  query can be bookmarked; it works without JavaScript. Only names from the catalog are used, and
  condition values are string literals.
- **Load Data**: load a CSV, TSV, Excel, JSON or XML file into a new table (with inferred column
  types) or an existing one (append, merge by primary key, or replace), with a per-row error
  report, or with a saved **data load definition**; a mapping can be saved as one
  ([chapter 16](16-files.md#sql-workshop--load-data)).
- **Unload Data**: download a table or view (chosen columns, an optional WHERE and ORDER BY) or a
  query as CSV, JSON, Excel or XML, streamed from a cursor in a read-only transaction
  ([chapter 16](16-files.md#sql-workshop--unload-data)).
- **Sample Data**: generate realistic rows for one or more tables of a schema (names, e-mail
  addresses, dates and numbers in a range, values from a list, foreign keys that pick existing parent
  rows, a percentage of nulls), proposed per column from the catalog; preview them, insert them in one
  transaction (parents first) or download them as SQL or CSV, with a seed for the same rows again;
  save the definition to rerun it ([chapter 16](16-files.md#sql-workshop--sample-data)).

Because the SQL Workshop runs as the owner, restrict who gets a developer account.

## Export and import

**Export** downloads the application as JSON: pages, all components, shared components and
settings. Since it's plain JSON you can commit it to git and review changes in pull requests.
In SQL: `select meta.export_app('hr')` and `select meta.import_app(<json>, 'new_alias')`.

For git, the [command line](18-cli.md) exports an application as a directory with one file per
component (`pgapex export hr --format dir`), shows what differs (`pgapex diff`) and imports it
again, also over the existing application (`pgapex import hr/ --replace`). The builder downloads
that directory as a zip from `/builder/apps/<id>/export?format=dir`.

### Export format

The format is `"format": "pgapex/2"`, and it's stable: files exported by pgapex 0.2.0 and later
import into every later version. New versions only **add** sections, and a missing section
imports as empty. Import refuses other formats.

| Section | Contents |
|---|---|
| `app` | the application's settings (name, alias, home page, authentication, theme, languages, …) |
| `authz_schemes`, `app_items`, `app_processes`, `lovs` | shared components |
| `group_roles` | identity-provider group → role mappings |
| `text_messages`, `translations` | globalization |
| `report_layouts` | report layouts; the logo as base64 |
| `template_components` | template components (regions and report columns refer to them by static id) |
| `web_credentials`, `rest_sources` | web credentials **without their secrets**, and REST data sources ([chapter 19](19-rest-data-sources.md)) |
| `data_load_definitions` | data load definitions ([chapter 16](16-files.md#data-load-definitions)) |
| `nav` | navigation menu (with ids, so parents can be linked again) |
| `lists`, `list_entries` | lists and their entries (with ids, so parents can be linked again) |
| `supporting_scripts` | supporting objects: install, upgrade and deinstall scripts (never run on import) |
| `pages` | every page with its `regions`, `items`, `buttons`, `dynamic_actions`, `validations` and `processes` |

Rows appear as they are in the `meta` tables (without their ids and the id of their parent), so a
new column travels along automatically.

**Not exported, on purpose:** accounts and who has access (they belong to an installation, not to
an app), OAuth clients and their secrets, the secrets of web credentials (enter them again after an
import), page locks and developer comments, sessions, activity logs, temporary files, and your
database objects (tables, views, functions: keep those in your own migration scripts). After an
import, check the app's database role under **Settings** and grant access under **Shared
Components**.
