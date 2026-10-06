# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Static application files** (migration 068): Shared Components → Static application files uploads or writes
  JavaScript, CSS, JSON, images and fonts (no HTML), served at `/a/<alias>/static/<name>` with long caching per
  version; every page or one page loads chosen `.js` and `.css` files; exported with the application (as the files
  themselves under `static/` in a directory export).
- **Execute JavaScript** dynamic action: calls a function a static file registered with
  `pgapex.actions.register(name, fn)`; the page receives only the name, so the CSP stays `script-src 'self'`.
  `window.pgapex` also offers `getValue`, `setValue`, `showSuccess`, `showError` and `clearErrors`. HR example:
  the salary per year on the employee form (`hr_46`).
- **Plug-ins with their own code** (migration 069): region, item, dynamic action and process plug-ins in one
  `pgapex-plugin/2` file (attributes, JavaScript/CSS as static files registered with `pgapex.plugins.register`, a
  template component for regions, a PL/pgSQL function for processes, install SQL run only on request as the app's
  role). Shared Components → Plug-ins; `meta.import_plugin()`; `pgapex plugin build|install`; four examples in
  `examples/plugins/` used on HR page 40 (`hr_47`).
- **Conditional and dynamic theme styles**: a Theme Roller style may have a SQL condition (the first style whose
  condition holds applies, unless the user chose one) and take any of its colours from an item (`&ITEM.`, used only
  when the value is `#rrggbb`).
- **More APEX APIs in SQL** (migration 070): `meta.parse_data` reads XML (the data loader's rules) and Excel files;
  APEX_ZIP as `meta.zip_add` / `zip_finish` / the aggregate `zip_agg` / `zip_entries` / `zip_entry`; the server
  unpacks .zip and .xlsx files it receives (uploads, web responses) for SQL, for 24 hours; `meta.v_boolean(item)`;
  an APEX_JSON → PostgreSQL mapping in the reference.
- **Object storage for file items** (migration 071): `object_store` keeps a file item's files in an S3-compatible
  bucket (AWS Signature Version 4, web credentials of the new type `aws_sigv4`); the source column holds the key;
  replaced and removed files are deleted after the commit, files of a failed save at once; downloads go through
  the app as before.
- **Map layers for large data sets**: a layer loads only the places in the visible area, again after each move
  (`"visible_area": true`, at most 2,000 with a "zoom in" note), or is served as **Mapbox Vector Tiles**
  (`"tiles": true`, MVT 2.1 encoded by pgapex without a dependency, at most 10,000 rows per tile), drawn on canvases
  with popups. Both filter on the server (PostGIS or latitude/longitude) as the application's role. *Load* in the
  map's settings; HR example page 41, 20,000 weather stations (`hr_48`).
- **Graphical query builder**: SQL Workshop → Query Builder shows the chosen tables as boxes on a canvas (dragged
  by a handle or moved with the arrow keys, placed where left), the joins as lines; drag a column onto a column of
  another table to join them (or choose the pair under Joins), instead of a cross join or the foreign key; column
  functions (count, count distinct, sum, average, minimum, maximum) with an automatic `group by`.
- **Tenants for workflows and tasks** (migration 072): `meta.set_tenant(tenant)` / `meta.tenant_id()` (APEX:
  `APEX_SESSION.SET_TENANT_ID`). Workflows, the tasks they create, tasks and background execution chains carry the
  session's tenant; the task list, the workflow console, `meta.tasks` / `meta.workflows` and every action reach only
  the session's tenant (a session without one: those without one).
- **Application files as text** (APEX 26.1: APEXlang): `pgapex export --format text` (and the builder's
  `?format=text` zip) writes the directory export as YAML, a strict subset any YAML tool reads, with SQL and templates
  inline as literal blocks; `import`, `diff` and zips read JSON and YAML files alike.
- **Region Static ID** (migration 073): optional, unique on the page; names the region in exported files (so renaming
  it keeps its file, references and, on `import --replace`, saved reports) and is rendered as `data-static-id`.
- **Lucide icons and icon modifiers** (APEX: Font APEX): about 1,600 more line icons (the `lucide-static` package,
  ISC) next to pgapex's 136, each served as its own cached file; modifiers after the name (`lg`, `2x`, `spin`,
  `rotate-90`, `flip-h`, `success`, …) and Font APEX names (`fa-users fa-lg`); the builder's icon picker searches
  them and takes any value.

### Fixed
- Query Builder: after *Apply* the tables kept the order of the list instead of the order chosen, so the aliases
  (and the ticked columns and conditions) could point at the other table.

## [0.30.0] - 2026-10-06

### Added
- **Icons**: 136 line icons (was 39), and an icon picker in the builder (a grid with a filter box, without script a list of radio buttons).
- **Accessibility audit**: axe-core checks every page of the HR example (light, dark and Iris) and the builder's main
  pages against WCAG 2.1 A and AA in the e2e tests; no violations allowed.
- **Cropping pictures** before upload: file items with `"crop"` (free, 1:1, 4:3, 3:4, 16:9, 3:2, 2:3) open a crop
  dialog (mouse and keyboard) for the chosen picture. HR example: the employee photo is square (`hr_45`).
- **Session sharing between applications** (migration 067): applications with the same session sharing group share a
  sign-in, each with its own access check and roles; signing out of one signs out of all.
- **Eight more built-in languages**: Finnish, Turkish, Greek, Russian, Ukrainian, Korean, Arabic and Hebrew (twenty-two
  in all; Arabic and Hebrew right to left).

### Fixed
- Accessibility: chart bars and groups with a description get `role="img"`; gauge drill links are named by their
  visible text; rich-text toolbar buttons are named by their action, not their glyph; a tree's linked branches no
  longer put a link inside the disclosure; tables that scroll sideways can be reached and scrolled from the keyboard.
- The region display selector's current tab was drawn in the accent's text colour (white on white in the light theme).
- Search hits in the builder are readable in the dark theme.

## [0.29.0] - 2026-10-06

### Added
- **Workspaces** (migration 064): workspaces group applications and the developers who build them. The App Builder
  shows the current workspace's applications (home, Recent, dashboard, boilerplates, subscription sources) and answers
  *Not found* for applications of other workspaces; developers with several workspaces switch in the account menu.
  New, imported and copied applications go into the current workspace (the CLI imports into Default). Administrators
  manage workspaces on Workspace utilities → Workspaces: add, rename, developers, move applications, delete when
  empty. Existing applications and developers are in the Default workspace. Not a security boundary between
  developers who write SQL: use separate installations for tenants that must not see each other.
- **Base style Iris** (like APEX 26.1's new default theme style): indigo accent, a deep indigo header, larger corners,
  softer shadows and its own dark palette, all with WCAG AA contrast. New applications start with it; existing ones
  keep *Standard* until switched in Settings → Theme → Base style. Own accent and header colours and Theme Roller
  styles still apply on top.
- **Drawers** (migration 065): a modal page opens as a centred dialog or as a drawer from the left, right, top or
  bottom edge (APEX: the Drawer page template, 26.1's top and bottom drawers), small, medium or large (Page Designer
  → Page → Dialog position and size). HR example: *Leave request* (page 7) is a drawer from the right.
- **Built-in template components**: avatar (and avatar groups), badge, comments, media list, metric card (APEX
  26.1) and timeline, available in every application as regions and report column templates; *Copy into this
  application* makes an editable copy that replaces the built-in one. HR example page 39 *Team overview*.
- **Theme Roller**: accent and header colours for dark mode (style variants and Settings → Theme), a live preview
  while you edit a style, and template options on items (migration 066: stretch, large, quiet, bold, hidden label)
  and report columns (bold, muted, no wrapping, monospace, right-aligned, centred).
- **Report row selection across pages**: rows chosen on one page of a report stay chosen while paging (each change
  is recorded in the selection item's session state), with a count of the selected rows.
- **Instance settings** (Workspace utilities, administrators): session idle time and length and sign-in throttling
  set in the builder (over the environment variables, picked up by every server within 30 seconds), and an overview
  of the server's configuration with secrets hidden.
- **Nine more built-in languages** for pgapex's own texts: Italian, Portuguese, Polish, Swedish, Danish, Norwegian,
  Czech, Japanese and Chinese (simplified), with their date formats and currency (fourteen in all).

## [0.28.0] - 2026-10-06

### Added
- **AI services and *Generate text with AI*** (migration 060): Workspace utilities → AI services
  (administrators) configures Claude (official `@anthropic-ai/sdk`, default model `claude-opus-5-5`, effort
  and server-side refusal fallback) or OpenAI (official `openai` SDK) with an encrypted, write-only API key
  (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), base URL, limits, per-app access with daily request and
  token limits, a Test button and a usage log (tokens, model, duration; never prompt or answer text
  below debug level 9). Page process `ai_generate`: text into an item, or structured output into several
  items (a schema built from the items, or your own). A dynamic action runs it without a page submit.
  From SQL: `meta.ai_generate`, `meta.ai_result`, `meta.ai_available`. Builder: AI usage per application.
  HR example page 37 "Leave assistant". Prompts, including item values, are sent to the chosen provider.
- **AI assistant region, agents and tools, natural-language report filters** (migration 061): region type
  `ai_assistant` with a conversation per session, context queries (RAG over developer queries, run as the
  app's role, read-only) and tools the model may call: SQL with bound, checked arguments (read-only unless
  marked as writing, row limit and timeout) and REST data sources, each optionally behind an authorization
  scheme. Report regions get an "Ask in your own words" box (NL2IR) that turns a question into the report's
  normal filters, search and sort. HR example page 38 "HR assistant".
- **App Builder AI** (migration 062): SQL Workshop → AI (SQL from a question, shown and never run
  automatically; explain a query or an error; describe tables and columns for LLMs, optionally as
  `COMMENT ON`, with AI drafts), and **Create pages with AI** on the application dashboard (proposed pages
  the developer reviews before they are generated). The builder's AI service is chosen by administrators.
- **Blueprints** (migration 063): Create → From a blueprint: a JSON spec of tables, pages, navigation and
  sample data, optionally drafted by AI, always reviewed, then created as a new application in one
  transaction. Blueprints can be saved.

### Fixed
- A server whose database lacks migrations no longer fails page by page with "column … does not exist":
  it answers every request with 503 and names the missing migrations, or applies them when started with
  `MIGRATE_ON_START=true`.

## [0.27.0] - 2026-10-05

### Added
- **Data Reporter** (migration 057): a region type where signed-in users build their own reports from
  tables and views the developer offers: columns, filters, grouping with totals, sorting and a chart;
  saved privately or shared with the application's users. Runs as the application's role (grants and
  RLS apply). HR example page 36 "My reports".
- **Sample data** (migration 058): SQL Workshop → Sample Data generates realistic rows for one or more
  tables, with generators proposed from the catalog and column names, foreign keys, unique and simple
  CHECK constraints respected, a seed, preview, insert in one transaction (parents first) or download
  as SQL or CSV, and saved generator definitions. New settings `SAMPLE_DATA_STATEMENT_TIMEOUT` and
  `SAMPLE_DATA_MAX_ROWS`.
- **Create application** from an Excel workbook with several sheets (or JSON with several arrays) as
  several tables with proposed foreign keys, from pasted CSV/TSV data, and from existing tables and
  views of a schema.

## [0.26.0] - 2026-10-05

### Added
- **Working copies** (migration 055): Working copies on an application makes a second application
  to change in isolation (same schema and data, no automations of its own). Compare and merge
  compares it with the main application per component, three ways, with a line diff; changes on
  one side merge, conflicts are chosen per component. Merge into the main application, or refresh
  the copy with the main application's changes; users, sessions, saved reports, secrets and
  automation switches stay. Locks are respected; merges are logged.
- **Theme, library and boilerplate applications** (migration 056): an application type in Settings.
  Other applications subscribe to a theme application's theme and template components, or a library
  application's lists of values, authorization schemes, build options, template components and
  lists (Shared Components → Subscriptions): the component is copied, shown as in sync or not, and
  refreshed on demand; the master publishes to all subscribers. Create application can start from a
  boilerplate application.

## [0.25.0] - 2026-10-05

### Added
- **Gantt, pyramid and polar charts**: Gantt with start/end, progress, milestones, dependencies, a
  today line and a time axis from hours to years; pyramid (area-proportional, or two series back to
  back as a population pyramid); polar area. Server-side SVG with tooltips, a data table and
  drill-down links like the other charts. HR example page 32 "Project plan".
- **Map layers and clustering**: up to 8 layers per map, each with its own query (markers, GeoJSON or
  PostGIS lines and areas, heat map), a legend to switch them, and marker clustering. A report can be
  filtered by the distance from the map's centre (`r<id>_near`) as well as by the visible area; with
  PostGIS installed the filters use `ST_Intersects`/`ST_DWithin`, otherwise latitude/longitude. HR
  example page 33 "Field visits".
- **REST data sources write back and synchronise**: insert, update, delete and fetch operations (path
  and JSON body templates) let forms and interactive grids edit a web service's rows; a
  synchronisation copies a source's rows into a local table (merge on key columns, optionally
  deleting missing rows; replace; append) from the builder, on a cron schedule or from SQL with
  `meta.request_rest_sync(name)` / `meta.rest_sync_status(id)`, with a run log. HR example page 34
  "Contacts (REST)". Migration 050.
- **OAuth2 password and refresh-token grants** for web credentials; refresh tokens returned by the
  token endpoint are stored encrypted (and replaced when rotated), so they survive restarts.

- **Debug messages** (APEX_DEBUG): a debug level per application (1–9) and a retention (1–90 days);
  `meta.debug(level, text)` and `meta.debug_enabled(level)` from application SQL; timed entries per
  request (page steps, regions, processes, branches, errors, SQL notices), viewed per page view under
  Activity → Debug messages. With debug off nothing is written. Migration 051.
- **Installation log**: every migration run is logged in `public.pgapex_install_log`; Workspace
  utilities → Installation (administrators) shows the version, install and upgrade runs, applied
  migrations and mismatches.

- **Web requests from SQL** (APEX_WEB_SERVICE): `meta.web_request(url, method, body, headers,
  credential, timeout_s)` and `meta.web_request_source(source, params)` queue a call that the server
  makes (right after the page process that queued it, otherwise on the scheduler pass after commit)
  through the allow-list, address checks and the app's web credentials; `meta.web_response(id)` /
  `meta.web_response_blob(id)` read the result. Responses are kept 24 hours. Migration 052.
- **Parsing files in SQL** (APEX_DATA_PARSER): `meta.parse_data()` and `meta.parse_data_columns()` for
  CSV/TSV and JSON in a bytea, with the data loader's column names and types (XLSX and XML: use the
  data loader). HR example page 35 "Parse and fetch".

- **Theme Roller style variants**: up to 10 saved styles per application (accent and header colour,
  font, font size, corner radius) with a default; users may pick one in the user menu or on My
  account (kept per app on the account). **Template options** on regions and buttons: fixed lists of
  CSS classes, chosen in the Page Designer. Migration 053.

### Changed
- The export leaves out OAuth2 passwords, refresh tokens and a synchronisation's run state; an
  imported synchronisation starts switched off. `pgapex import --replace` keeps the new secrets.

### Fixed
- The Gantt "today" line uses the session's time zone.

### Security
- See SECURITY.md for the notes on charts, map layers, REST write-back and synchronisation, debug
  messages, `meta.web_request()`/`meta.parse_data()` and the Theme Roller.

## [0.24.0] - 2026-10-05

### Added
- **Automations** (migration 044): several ordered **actions** per automation, each with its own
  condition (row values as binds); **error handling** per automation: stop (as before), skip the row
  and continue, or disable; failed rows and their errors in the run history (status `warning`);
  **`meta.run_automation(name)`** runs an automation from application SQL, synchronously in the
  caller's transaction (like `APEX_AUTOMATION.EXECUTE`). Existing automations become one action.
  Export/import and the CLI directory format carry the actions. HR example part 33.
- **Workflows**: an **invoke API** step calls a REST data source of the app or a URL through the same
  code as the invoke-API process (allow-list, SSRF checks, web credentials); response values and the
  HTTP status go into workflow variables; no transaction stays open during the call; a failed call
  faults the step (retry in the console). HR example part 34.
- **Data Workshop → Unload Data**: a table or view (chosen columns, where, order) or a query to CSV
  (separator, enclosure, heading, BOM; formulas neutralised), JSON, XLSX or XML; streamed with a cursor
  (capped by `DOWNLOAD_MAX_ROWS`) in a read-only transaction with a statement timeout
  (`UNLOAD_STATEMENT_TIMEOUT`, default 5min); logged as `sql_unload`.
- **Create page wizards** (migration 047) for form, cards, calendar, chart, map, faceted search and
  master-detail pages, next to report and form and interactive grid: pick a table or view, review the
  options proposed from the catalog (columns, key, dates, positions, foreign keys), optionally add a
  modal form page and a navigation entry. Also from SQL with `meta.generate_page(...)`.
- **Create application from a file**: Create → From a file uploads a CSV, TSV or XLSX file (JSON and
  XML work too), shows a preview with editable table and column names and types, and creates the app
  with its own schema and role, the table (identity key) with the rows, a report and form, and an
  optional dashboard chart and faceted search page, all with navigation.

### Changed
- CI: `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` v7 (Node.js 24).

### Fixed
- A flaky custom-authentication test (page views are logged without awaiting).

### Security
- The create-application wizard refuses `meta`, `information_schema` and `pg_*` as the parsing
  schema (before, a developer could make an app role with DML on `meta`); a blank app needs a name and
  its alias is at most 50 characters.

## [0.23.0] - 2026-10-05

### Added
- **Interactive grid** (migration 038): aggregates over the whole result in a footer (developer and
  user defined); 1–5 frozen columns; column reorder, resize and hide (Actions → Columns without
  JavaScript, drag and drop with it); layouts and saved grid reports per user (private or public);
  **master-detail** (a master grid's signed row selection sets a page item, detail regions refresh in
  place, detail grids fill the master column); a row actions menu (edit, duplicate, delete, links);
  copy and paste of cell ranges as tab-separated text. HR example page 27 "Departments and staff".
- **Page logic** (migration 039): a **download** process (a file from a query; several rows in one
  zip; on submit or on load); **execution chains** with child processes and their own conditions,
  optionally run **in the background** (a queue with SKIP LOCKED, NOTIFY and polling, status view
  `meta.process_jobs`, a Jobs tab in the designer); **workflow** processes (start a version, terminate,
  retry); branches to a **function returning a URL** and to a page of **another application**; the
  dynamic action event **Dialog Closed**. New settings `BACKGROUND_PROCESSES` and
  `PROCESS_JOB_INTERVAL_S`. HR example page 28 "Employee toolkit".
- **Globalization** (migration 040): Oracle-style **number format masks** on report, grid and cards
  columns, charts, PDF columns and number/display items, with the language's separators and the app's
  currency; **Automatic Time Zone** (the browser's zone at sign-in and from app.js, a choice on My
  account, the app's or the database's), `timestamptz` shown in it; built-in runtime messages in
  **German, French and Spanish**. HR example page 29.
- **SQL Workshop and Data Workshop** (migration 041): **SQL Scripts** (saved, upload/download, a
  result per statement, stop or continue, optionally one transaction, run history); **Quick SQL**
  (shorthand to DDL); a simple **query builder**; **XML loading**; saved **data load definitions**
  (mapping, transformations, format masks, defaults) for Load Data and the `data_load` process,
  exported with the app.
- **Builder** (migration 042): **custom authentication** (a PL/pgSQL function or body, with
  post-authentication code); generic **Lists** as a shared component, a list region and the
  navigation menu or bar; **page and application locks** and **developer comments**, with an
  administrator flag for developers; **supporting objects** (install, upgrade and deinstall scripts in
  the export, run from the builder). HR example page 31 "Shortcuts".

### Changed
- Export and import (migration 043) include data load definitions, lists, list entries and supporting
  scripts.
- Number items refuse text that isn't a number (422), as in APEX.
- SQL Commands run on their own connection and are written to the activity log (up to 2,000
  characters).

## [0.22.0] - 2026-10-05

### Added
- **Keyset ("seek") paging** for row-range reports (`"keyset": ["id"]`): Next and Previous carry the
  last/first row's sort values in a signed parameter, so deep pages stay fast on an indexed sort.
- **Database-account authentication** (APEX: Database Accounts; migration 037): an app type
  `database` where users sign in with a PostgreSQL login role and its password, checked by
  PostgreSQL through a short-lived connection. Only the listed roles or members of a role may sign
  in; superusers and pgapex's own roles never.

### Changed
- Report PDFs read their rows from a cursor in batches of 500 and draw them as they arrive
  (`PDF_MAX_ROWS`, default 5,000, at most 100,000).
- REST collection handlers stream a chunked JSON array from a cursor.

## [0.21.0] - 2026-10-04

### Added
- **HTTP header authentication** (APEX: HTTP Header Variable; migration 036): an app type `header` for
  apps behind a reverse proxy or SSO gateway that sets the user in a header (`X-Remote-User` by
  default). The header is trusted only from the proxy addresses in `PGAPEX_AUTH_HEADER_PROXIES`; the
  session is bound to its value; accounts can be created automatically; an optional sign-out URL.

## [0.20.0] - 2026-10-04

### Added
- **Popup LOV** item (`popup_lov`): a dialog with a search field that searches the item's list of
  values on the server, a page at a time (`page_size`, at most 100), with extra columns and a return
  value separate from the shown one. The posted value is checked against the list. Without
  JavaScript it is a select list.
- HR example page 26 "Pick an employee".

## [0.19.0] - 2026-10-04

### Added
- **Row ranges** for reports and grids (`"pagination": "range"`): "Rows X–Y" without counting every
  row, and a **maximum row count** (`max_rows`: "of more than N", downloads capped too).
- **Row limits** for cards (500), charts (1000), dynamic content (1000) and lists of values (5000),
  configurable with `max_rows`; "Showing the first N rows." when cut off.
- **Lazy loading of regions** (`"lazy": true`): a placeholder, fetched after the page shows, with a
  link when JavaScript is off.
- **Region caching** per user, session or all users for a duration (`"cache"`), emptied when the page
  is submitted; `REGION_CACHE_MAX_ENTRIES` and `REGION_CACHE_MAX_MB`.
- Page Designer → Report settings: a *Large tables* section.
- HR example page 25 "Large tables" (200,000 rows).

### Changed
- CSV and Excel downloads stream from a database cursor, so memory stays flat; the limit is
  `DOWNLOAD_MAX_ROWS` (default 1,000,000, was 100,000).
- Page numbers and page sizes are clamped on the server; a select list shows at most 5,000 options
  unless the item sets `max_rows`.
- The grid no longer shows "Rows: 0" when it is empty.

### Fixed
- The App Builder home's table was wider than a tablet screen with some fonts (CI e2e failure).
- HR page 23's hint now names `PGAPEX_REST_PRIVATE_HOSTS=127.0.0.1:3100`.

## [0.18.0] - 2026-10-04

### Added
- **Calendar views** (APEX: calendar): month, week, day and list views, create on click (a
  checksummed link with the clicked slot) and drag and drop to move events through the region's
  move SQL, run as the application's role. Works without JavaScript; dragging adds on top.
- **Bubble, gauge, funnel and radar charts**, and **drill-down links** on chart marks
  (checksummed, only to pages the user may open).
- **Smart filters** region (APEX 22.2+): one search field with filter chips and suggestions over a
  report, URL-based, no JavaScript needed.
- **Region display selector** (migration 031): tabs or a select list over the regions of a page,
  shared tabs, *Show all*, the choice remembered in the session, `#R<id>` links.
- **Faceted search**: range facets (predefined, or a custom from/to on numbers and dates), star
  rating and search facets, and *exclude* on checkbox facets (26.1).
- **Computations** and **conditional branches** (migration 029): computations before header and
  after submit (static, item, SQL query, SQL expression, PL/pgSQL), branches before header and
  after processing to a page or a URL in the app, with conditions and *When button pressed*.
- **Build options**: include/exclude switches on pages and every component, navigation entries and
  application processes, with *Used in*, the Advisor and export.
- **Menu buttons and button badges** (26.1), and the dynamic actions **Set Focus**, **Add/Remove
  Class**, **Show Success/Error Message** and **Clear Errors** (26.1).
- **REST data sources and web credentials** (migration 030, new chapter 19): JSON web services as
  rows for reports, cards, charts, calendars, maps, trees, template components and lists of values;
  basic, API-key, bearer and OAuth2 client-credentials sign-in with encrypted, write-only secrets;
  an **Invoke API** page process. Outgoing calls only to hosts on `PGAPEX_REST_ALLOWED_HOSTS`, with
  SSRF checks; secrets need `PGAPEX_SECRET_KEY`.
- **New item types** (migration 032): `richtext` (HTML rebuilt from an allow-list on the server
  every time it is saved and shown; pasted HTML is cleaned), `markdown` (rendered on the server),
  `rating` (stars), `combobox` (free text with suggestions, as tags), `daterange` (`from:to`) and
  `qrcode` (SVG drawn on the server, no dependency), and a show/hide button on password items
  (`{"reveal": true}`). All work without JavaScript.
- HR example pages 20 (Reviews), 21 (Explore), 22 (Leave planner), 23 (Web services) and 24 (Planner).

### Changed
- Report search terms, facet values and range bounds are sent to PostgreSQL as query parameters.
- A facet filter in a report's URL (`r<id>_x_<column>`) only applies when the page has a facet on
  that column.
- Migration 034 brings the export and import functions of migrations 029–031 together.

## [0.17.1] - 2026-10-01

### Fixed
- Workspace Utilities → Password policy answered with a server error: it now opens the Users page
  at Account settings.
- A builder URL with an id that isn't a number (e.g. `/builder/apps/abc`) answered 500 with the
  database's error message; it is now a 404.

## [0.17.0] - 2026-10-01

### Added
- **App Builder home like APEX's**: four tiles (Create, Import, Dashboard, Workspace Utilities), the
  applications as a report (id, name, alias, pages, views, sign-in, updated, Edit / Run) or as
  cards, a search that filters as you type, sortable columns and an Actions menu, and a side column
  with About, Recent (the applications you opened) and Tasks. Create and Import are pages of their
  own.
- **Workspace dashboard** (`/builder/dashboard`): applications, pages, active accounts, page views,
  users, failed sign-ins and errors of the last 24 hours, and per application the last 7 days.
- **Workspace utilities** (`/builder/utilities`): users, identity providers, LDAP directories,
  password policy, developers and the SQL Workshop in one place.
- A status bar on every builder page: who is signed in, the database, the language and the
  pgapex version.

### Fixed
- **Map tiles from OpenStreetMap showed "Access blocked" (403)**: pgapex's `Referrer-Policy:
  same-origin` sent tile requests without a `Referer`, which OpenStreetMap's tile policy refuses.
  The tile layer now sends the site's origin (never the page's path or query).
- The page designer's gallery showed the raw type name of template component regions.

## [0.16.0] - 2026-10-01

### Added
- **Page Designer and builder look** (APEX: Page Designer): an IDE-style builder window with an
  icon rail, a toolbar and breadcrumb, dark by default (light or system from the account menu).
  The Page Designer has a component tree, a layout canvas where regions, items and buttons are
  dragged into place or wider/narrower, a gallery to add new ones, a filterable property editor
  with an Attributes tab for region settings, undo/redo, zoom and maximize. Keyboard shortcuts
  (Alt+↑/↓, Alt+Shift+←/→) and Arrange buttons do the same without a mouse; below 1024px the panes
  become Tree / Layout / Properties tabs.
- **Code editor** for the builder's SQL, PL/pgSQL, JSON and HTML fields and the SQL Workshop:
  highlighting, line numbers, bracket matching, indenting, and suggestions for tables, columns
  and `:ITEM` binds of the application's own database role (Ctrl+Space, or a Suggest button on
  touch screens). Plain JavaScript, no new dependency; without JavaScript it's a normal text field.
- **Template components** (APEX 23.1+; migration 028): HTML templates with escaped
  `#PLACEHOLDERS#`, `{if}`, `{case}` and `{loop}` directives, custom attributes and a wrapper,
  used as a `template_component` region and as report column templates, with a preview.
  Templates are checked against an allow-list (no scripts, styles, event handlers or
  `javascript:` links). Included in application export/import.
- **Plug-ins**: a template component is exported and imported as one file; three examples in
  `examples/plugins` (status badge, contact card, timeline item).
- **Parallel branches in workflows** (APEX 26.1; migration 027): a `parallel` step runs branches
  side by side until a `join` that waits for all of them or for the first (the others are
  cancelled), nested branches included.
- **Workflow versions** (APEX: development / active / inactive): a new version is edited while
  the active one runs, then activated; running instances keep the version they started with.
  Instance diagrams in the builder show where each branch is.
- **The `pgapex` command line**: `migrate`, `apps`, `export` (one JSON file or a directory),
  `import` (JSON, directory or .zip; `--replace` updates an application in place and keeps its
  access, sessions, saved reports, tasks and workflows), `diff` and `users`.
- **One file per component** (APEX 26.1: APEXlang-like app files): `pgapex export --format dir`
  writes sorted JSON per component, SQL and HTML in sibling files, and references by static id
  instead of database ids, for git; the builder downloads the same layout as a .zip.
- HR example: onboarding version 2 prepares the workplace and access in parallel; page 19 "Team"
  uses template components.

### Fixed
- Workflow definitions and REST modules could not be saved in the builder: their check read the
  JSON field as text and refused every save.
- Importing an export without workflow versions fills in version 1.

## [0.15.0] - 2026-10-01

### Added
- **Drop and paste files** (APEX 26.1: paste files): file items are drop zones, and a pasted file
  (a screenshot, a copied file) goes into the focused file item, or the page's only one. Text
  fields keep their normal paste; a file dropped next to a zone doesn't open in the browser.
- **Heat maps** (`"layer": "heat"` on a map region): places drawn as a heat map, weighted by a
  `weight` column, with a legend.
- **Filter a report by the map area** (`"report": <id>` on a map region; APEX: map bounding box):
  after moving the map, "Show this area in the list" filters the report on the same page to the
  visible area (its lat/lng or location columns), with a "Map area" chip. Migration 026 keeps the
  link when an application is imported. Both are in the builder's map settings.
- HR example: page 16 "Locations" (a payroll heat map, and an offices map that filters the
  employee list).

### Changed
- Report column headings set in the region's configuration are translated like generated ones.

## [0.14.0] - 2026-10-01

### Added
- **More chart types** (APEX: stacked, combination, scatter and pie charts): `stacked` columns
  (negative values stack downwards), `combo` (the first series as columns, the others as lines),
  `scatter` (a numeric first column as the x axis) and `pie`, next to bar, column, line, area and
  donut. The interactive report's chart view also offers pie. The HR example has an "Analytics"
  page with one chart of each new kind.
- **Several files per upload item** (`"multiple": true`; APEX: Allow Multiple Files): users choose
  several files at once. In a form region each file becomes a row of a child table (`table`,
  `parent_column`, `key_column`), listed with signed download links and a remove box per file;
  without one the item holds a list of temporary files for a process. `max_files` (at most 10)
  limits the number. The HR employee form has a "Documents" item (`hr.emp_document`, with row
  level security). With `max_px`, every chosen photo is made smaller before upload.

## [0.13.0] - 2026-10-01

### Added
- **Map region** (`map`, migration 025; APEX: Map region): markers from `lat`/`lng` columns or
  `location` text, GeoJSON lines and areas, popups with links, sized small/medium/large. Leaflet
  1.9 ships with pgapex and loads only on pages with a map; tiles come from OpenStreetMap or the
  server in `MAP_TILE_URL`, the only image origin added to the Content-Security-Policy.
- **Tree region** (`tree`; APEX: Tree): id/parent id/label rows as an expandable tree with icons
  and links, drawn on the server (works without JavaScript).
- Builder settings forms for both; the Advisor checks their SQL. The HR example maps its offices
  and shows its reporting lines as a tree.

## [0.12.0] - 2026-10-01

### Added
- **REST modules** (Shared Components → REST modules, migration 024; APEX: RESTful Services):
  handlers with a method, a path with parameters and SQL (a paged collection, one item, or
  statements), roles and public endpoints, served by pgapex under `/a/<alias>/rest/<module>/` with
  bearer tokens, as the application's role (RLS applies), and an OpenAPI description per module.
  The HR example has a `v1` module.

### Changed
- Tokens and OAuth clients no longer need an API role: without one they are valid for the REST
  modules pgapex serves (PostgREST treats them as anonymous).
- Builder property groups (fieldsets) no longer grow wider than the screen with long content.

## [0.11.0] - 2026-10-01

### Added
- **Progressive Web Apps** for mobile and field work (App → Settings, migration 023): installable
  (manifest, icon, service worker per application), offline pages (opt-in; wiped at sign-in and
  sign-out), an offline page, and **forms sent offline** kept on the device (files included) and
  sent when the connection is back, under the same user, at most once. New chapter 17.
- **Field items**: `location` (*Use my location*, `latitude,longitude`, checked on the server), camera
  capture and photos made smaller before upload on file items, a barcode/QR *Scan* button on text items.
- Page forms carry a submission id (a resend is never processed twice) and their form's record key,
  signed, so a form sent later updates the record it was opened for.
- **Workflows** (Shared Components → Workflows, migration 022): definitions of task, SQL, switch,
  wait and end steps with variables, started from application SQL with `meta.start_workflow(…)`,
  run by the pgapex server (on `NOTIFY` and every few seconds; `WORKFLOWS=off` to disable) one step
  per transaction as the application's role. A `workflows` region is the console (terminate, retry
  a faulted step); the builder checks the steps and draws them. The HR example starts an onboarding
  workflow from its employee form.

### Changed
- `Permissions-Policy` allows the camera and geolocation for the application itself
  (`camera=(self), geolocation=(self)`); the microphone stays off.

## [0.10.0] - 2026-10-01

### Changed
- **pgapex installs no application.** The HR sample moved from `db/seed/` to `examples/hr/` as an
  example application built on pgapex: `npm run setup` and `npm run db:reset` install the framework
  only, `npm run example:hr` adds the example, and `npm test` / `npm run test:e2e` install it first
  as their fixture. `npm run db:seed` is gone; `migrate.ts --seed` still reads an older release's
  `db/seed/` (upgrade test). Databases that have the sample carry on: files are recorded by name.
- Builder defaults, placeholders and help texts use neutral examples instead of HR tables, and the
  report-layout preview shows made-up order rows.

### Added
- **Approvals and the task list** (migration 021): task definitions (Shared Components), tasks created
  from application SQL with `meta.create_task(…)`, a `tasks` region type (claim, approve / reject /
  complete with a comment, release, delegate, cancel, comments and history) and completion SQL that
  runs as the application's role in the same transaction. Rights are checked by the `meta.*_task`
  functions and the `meta.tasks` view. The HR example's leave requests use it (*My tasks*, page 14).
- **Document templates** (Shared Components → Document templates, migration 020; APEX: Document
  Generator): a query fills an HTML template with Mustache-style tags (values always escaped;
  lists from JSON columns; number and date filters), drawn as a PDF with a report layout. Buttons
  with action *document* and `?doc=NAME` links download them; the builder previews them. The HR
  sample's employee form has a *Print* button (employee sheet).
- Data loading reads **JSON**: an array of objects, an object holding one, or JSON Lines.
- **"Keep me signed in"** (APEX: persistent authentication), per application for 1–365 days: a
  rotating one-time token in a long-lived cookie starts a new session when the old one has ended.
  Signing out, a new password, deactivation or removed access ends it; My account has *Sign out on
  all devices*. Migration 017.
- **LDAP and Active Directory** sign-in (Users → LDAP directories, migration 018): the password form
  checks local accounts, then the app's directories (search, bind as the user, groups → roles,
  StartTLS/LDAPS). Demo directory: `docker compose --profile ldap`, `examples/ldap-directory.sql`.
- **SAML 2.0** single sign-on next to OpenID Connect (migration 019): signed assertions, issuer,
  audience and one-time `InResponseTo` checks, SP metadata at `/sso/saml/<name>/metadata`. The
  development Keycloak realm has a SAML client (`examples/keycloak-saml.sql`).

## [0.9.0] - 2026-10-01

### Added
- App Builder **Search** over every page and component of an application, and a **Used in** list
  under items, pages, lists of values, authorization schemes and report layouts.
- **Advisor**: plans every SQL fragment of an application with EXPLAIN as its database role
  (rolled back, nothing runs), compiles PL/pgSQL blocks, finds references to missing pages,
  items, lists of values, schemes and layouts, and checks PL/pgSQL functions with `plpgsql_check`
  when that extension is installed.
- **Top SQL** per application (Activity → Top SQL) from `pg_stat_statements`. Migration 016
  creates the extension when possible; `docker-compose.yml` and CI load the module.
- **Region settings** in the page designer for grid, chart, cards, calendar and faceted search
  regions, like the report settings: grid columns (heading, shown, read-only, required, list of
  values) and add/change/delete switches; chart type; cards style and link; calendar link; the
  facets' report and per facet its label, values shown and order. Saving keeps unknown keys and
  leaves defaults out; links, lists of values and the report are checked server-side.
- Interactive reports: **computed columns** (Actions → Compute, e.g. `sal * 12`; a small
  expression language that is parsed, never pasted into SQL), **group by** (up to three columns
  with row counts and functions), **pivot** (values of a column as columns, with row totals) and
  a **chart view** (bar, column, line, area or donut), with Report / Group by / Pivot / Chart links
  once set up. All of them are kept in saved reports.
- **Row selection** for report regions: `"selection": {"column": …, "item": …}` (also in the
  Report settings form) adds a checkbox per row and a *select all*; on submit the checked values
  reach the item, colon separated.

### Security
- The Content-Security-Policy no longer allows inline styles: `style-src 'self' 'nonce-…'` with a
  new nonce per response. Chart geometry and theme colours go into the page's one nonce'd
  `<style>` as classes (`src/css.ts`); a refreshed region sends its rules along and `app.js` adds
  them through the CSSOM. The builder uses CSS classes instead of `style` attributes.
  **Upgrade note:** `style="…"` attributes and `<style>` blocks in your own static or dynamic
  region HTML are now ignored by browsers; use the classes in `/static/app.css`.

### Fixed
- Chart legend swatches were grey since 0.8.0 (the highlight chip's swatch rule applied to them).

## [0.8.0] - 2026-09-30

### Changed
- Long help texts (JSON examples) wrap instead of widening the builder on phones.
- Application export and import are one pair of functions again (migration 013 replaces the
  wrapped `export_app_base`/`import_app_base` chain). The format stays `pgapex/2` and is now
  documented, with a compatibility promise: sections are only added, and missing sections import
  as empty.
- The builder's route file is split into `routes.ts`, `shared.ts`, `designer.ts`, `sql.ts` and
  `forms.ts` (no behaviour change).

### Added
- Interactive reports: **control break** (group rows by a column), **aggregates** (sum,
  average, count, minimum, maximum over all filtered rows, with subtotals per group and a
  total), **highlights** (color matching rows) and **saved reports** (private per user; public
  ones for users who pass the region's `public_reports` scheme). Migration 014 adds
  `meta.saved_report`, reached through `meta.saved_reports`, `meta.save_report()` and
  `meta.delete_saved_report()`.
- **Automations** (Shared Components → Automations, migration 015): SQL or PL/pgSQL on a cron
  schedule with a time zone, once or for each row of a query, as the application's database role
  with the automation's roles for `meta.has_role()`. Run now, next run and run history in the
  builder. The pgapex server schedules them (no extension needed); several servers never run
  one twice; `AUTOMATIONS=off` switches the scheduler off. Exported with the app; imported
  copies start switched off. HR sample: *Remind managers*.
- **Report settings** in the page designer: a form for a report region's rows per page,
  search/sort/Actions switches, saved and public reports, per-column heading, visibility, printing
  and PDF width, the link and the PDF layout. Columns are read from the query. It writes the
  region's JSON attributes and keeps other keys.
- CI: an `upgrade` job installs v0.6.0 and v0.7.0 with sample data, upgrades and runs the tests;
  `scripts/migrate.ts --root` applies another release's `db/` folder.
- `test/export.test.ts`: export → import → export round trip, older files, and a check that every
  table of an app or page is exported (or deliberately left out).

## [0.7.0] - 2026-09-30

### Added
- OAuth clients for the REST API, like ORDS's `oauth.create_client`: client credentials
  (`POST /oauth/token`, HTTP Basic or form fields) give short-lived tokens that PostgREST accepts,
  so tokens never need rotating by hand. Clients act as `client:<name>` with roles that are read
  live; revoking works at once. Secret rotation with a grace period. Managed under Builder → REST
  API → OAuth clients or with `meta.oauth_create_client()`, `oauth_rotate_secret()`,
  `oauth_revoke_client()`, `oauth_grant_role()` and `oauth_revoke_role()` (migration 011).
- **Download Excel** for interactive reports: an `.xlsx` with the rows, filters and headings
  of the report; numbers, dates and booleans keep their type, text never becomes a formula.
- **Report layouts** (Shared Components → Report layouts, migration 012): paper size (A3, A4,
  A5, Letter, Legal), orientation, font size, margins, table width, title/header/footer texts
  with substitutions, colors and a PNG/JPEG logo, with a PDF preview. Reports pick one in their
  settings (`"pdf": {"layout": …, "columns": […], "widths": {…}, "align": {…}}`), or use the
  application's default layout. Layouts are included in exports. HR sample: the Directory
  prints with `HR_DIRECTORY`.
- Printing: interactive reports get **Download PDF** (A4, landscape when wide; title, active
  filters, repeated headings, page numbers; same query, filters and access checks as the
  screen) and **Print** in the Actions menu; every page has a print stylesheet without
  navigation and toolbars. `PDF_FONT` / `PDF_FONT_BOLD` embed a TrueType font for scripts
  beyond Western European; `PDF_MAX_ROWS` (default 5000) limits the rows.
- Data loading (CSV, TSV, Excel .xlsx):
  - SQL Workshop → **Load Data**: upload, preview, then load into a new table (column names
    and types inferred) or an existing one (columns mapped by name; append, merge by primary
    key, or replace), with a per-row error report. Nothing is loaded when a row fails unless
    "skip rows with errors" is ticked.
  - Page process type `data_load` loads a file item's file into a table as the application's
    role (grants, RLS, triggers apply); row errors are shown on the file item. HR sample:
    page 13 *Import employees*.
- File upload items (APEX *File Browse*): item type `file` saves into a form's bytea column
  (with file name and MIME type columns) or into the session's temporary files
  (`meta.temp_files`, like `APEX_APPLICATION_TEMP_FILES`). Image previews, remove option,
  size (`max_mb`, `MAX_UPLOAD_MB`) and type (`accept`) limits, and signed downloads that run
  as the application's role (row level security applies). Uploads survive validation errors.
  HR sample: employee photo.
- Role suggestions in the builder: roles fields (Users → account, and the app's Access control)
  list the roles the application checks (authorization schemes, `meta.has_role()` in SQL, group
  mappings, roles in use); click to add, hover to see where each role is checked.

## [0.6.0] - 2026-09-30

### Added
- Chapter 15, *Useful PostgreSQL extensions*: contrib and third-party extensions mapped to APEX
  features (scheduling, web services, maps, AI search, auditing, Oracle compatibility), with
  security notes and tested examples (`test/extensions.test.ts`).
- Exclusion-constraint violations (e.g. overlapping date ranges with `btree_gist`) get a friendly
  message, like check constraints.

### Changed
- The APEX 26.1 parity matrix was re-reviewed: 116 features compared, with counts per area and
  sections on deliberate differences and gaps that extensions close. The CSP row is now partial
  (inline styles are still allowed).

### Removed
- **E-mail and "forgot password"** (they were in the unreleased 0.5.0 development builds): the mail
  queue, `meta.send_mail()`/`send_mail_template()`/`add_attachment()`, e-mail templates, the *Send
  e-mail* process, Builder → Mail, the SMTP settings, the Mailpit container, and the forgot/reset
  password pages. pgapex doesn't send mail; administrators set temporary passwords (with change on
  first use) instead. Migration `008_drop_mail.sql` removes the objects from databases that ran the
  development builds; fresh installs never create them.

## [0.5.0] - 2026-09-29

Not tagged as a release: its development builds included e-mail, which 0.6.0 removed again.

### Added
- **My account** in every application: change your own password, choose light or dark and the language.
- Password policy and APEX-style account controls:
  - change of password on first use;
  - password lifetime (expiry);
  - expire/unexpire and admin reset (also as `meta.set_password()`, `meta.expire_password()`);
  - minimum length, letters and digits;
  - unlock after failed sign-ins (Builder → Users).
- **Light/dark switch**: an app theme style (automatic, light, dark) and "users may choose", saved on the account.
- **Globalization**:
  - a primary language and translated languages per app, chosen from the browser, the user's preference or `?lang=`;
  - translations of all app texts in the builder, with XLIFF 1.2 and CSV export/import;
  - text messages (`meta.message()`, `&APP_TEXT$NAME.`);
  - pgapex's own texts in English and Dutch;
  - date and timestamp masks;
  - right-to-left languages.
- The HR sample in Dutch.
- New chapter 14, *Globalization*.

### Changed
- Upgrade note: migrations 006–007 add the new tables. Existing passwords count as changed at upgrade time for the password lifetime.

## [0.4.0] - 2026-09-29

### Added
- User directory (Builder → Users): one account per person for all applications, with per-application access control ("only listed accounts" or "any active account") and roles per application, like APEX workspace accounts with Application Access Control.
- Single sign-on with OpenID Connect: identity providers (Builder → Users → Identity providers), sign-in methods per application, identity-provider groups mapped to application roles, account linking by subject, optional automatic account creation. A Keycloak demo is included (`docker compose --profile sso`, `examples/keycloak-sso.sql`).
- REST APIs with PostgREST running next to pgapex (`docker compose --profile api`): `meta.app_user()`, `meta.app_id()` and `meta.has_role()` understand PostgREST's JWT claims, so the same RLS policies protect the UI and the API; a per-application API role; the pre-request check `meta.api_check()` (inactive accounts and revoked access are refused at once); Builder → App → REST API with endpoints, token issuing and curl examples. The HR sample has an `api` schema (`db/seed/hr_03_api.sql`). New chapter 13.
- `PUBLIC_URL`, `API_URL` and `API_JWT_SECRET` settings.

### Changed
- Roles are resolved at sign-in and stored with the session; `meta.has_role()` reads them.
- `meta.app_user` is now a compatibility view over `meta.account` and `meta.app_access`.
- **Upgrade note:** migration 003 moves existing per-application users into the directory. A username that existed in several applications is kept for the first application and renamed `username@alias` for the others (they can't be assumed to be the same person). Existing application sessions end.

## [0.3.0] - 2026-09-29

### Added
- Responsive layout for phones, tablets and desktops: navigation drawer, reflowing reports and grids, full-screen dialogs, bottom-sheet menus, touch-sized controls; browser tests at four viewport sizes (`npm run test:e2e`).
- Interactive grid region with inline editing, adding and deleting rows (signed row keys, per-row errors).
- Charts: column, line, area and donut, with multi-series support, tooltips and data tables.
- Calendar, faceted search and dynamic content regions.
- Item types: checkbox group, multi-select, searchable popup list of values, email, phone, URL, colour.
- Shared lists of values, theme colours and top navigation.
- "Interactive grid" page wizard.
- APEX feature parity matrix (`docs/apex-feature-parity.md`).
- Open source packaging: Apache-2.0 license, contributing guide, code of conduct, CI, issue templates.

## [0.2.0] - 2026-09-29

### Added
- Universal Theme-style UI: side navigation, breadcrumbs, user menu, 12-column grid, dark mode.
- Interactive report actions (column filters, rows per page, CSV download), cards and metric cards, modal dialog pages.
- Dynamic actions, cascading lists of values, radio/switch items, read-only conditions, static lists of values.
- Shared components: navigation menu, authorization schemes, application items, application processes.
- Builder: tree-based page designer, shared components, activity monitor, SQL Workshop object browser, developer accounts.
- HR sample with PL/pgSQL workflows, triggers and row level security.
- Security hardening (see SECURITY.md) and a security regression test suite.
- Versioned migrations (`npm run db:migrate`).

## [0.1.0] - 2026-09-29

### Added
- First version: metadata repository, runtime (reports, forms, charts, static regions), bind variables, validations, processes, login, builder, CRUD wizard, export/import.
