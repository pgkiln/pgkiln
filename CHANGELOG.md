# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Spacing between stacked regions in the builder**: regions placed one under another (Team Development milestones,
  workspace and DB user pages, working copies, blueprints, the Session Monitor, Data Reporter and ~90 more pages)
  touched each other; they now keep 1rem between them, as in applications. Grids that already space their regions
  (Shared Components, Quick SQL) are unchanged. Also: buttons side by side in a table cell (SQL Scripts), the role
  chips on a user's page and the regions of an application's Feedback page.

## [0.53.0] - 2026-10-20

### Added
- **Data security per table** (WS-13; APEX 26.2: Deep Data Security): SQL Workshop → Object Browser → a table →
  **Security** (also *Security…* in its ⋯ menu) shows the table's row level security policies, a matrix of
  **database roles × columns** with *read* and *update* (written as `GRANT` / `REVOKE` on columns), and **masked values
  per application role** (`meta.has_role()`): empty, `***` or `***` plus the last four characters, in a masking view
  next to the table owned by a role per schema (`<schema>_masking`), so the table's row level security still applies
  inside it. Preview SQL, Apply in one transaction (recorded in the Change Log) or Open in the worksheet. The
  configuration lives in the view's comment: no migration. The mask holds where a role reads the view instead of the
  raw column; the preview warns while a role can still read it. HR example page 48 *Salaries (masked)* (`hr_70`).
- **MCP `run_query` as an application's user**: with `alias` (and `user`) the query runs as that application's database
  role with `meta.app_user()` and `meta.has_role()` set, so grants, column privileges, row level security and masking
  views apply as on the user's pages ([chapter 20](docs/guide/20-ai-agents.md#safety)).
- **App Builder list details** (WS-12; APEX: the Applications report; migration 125): the report shows **Updated by**
  (the developer who changed the application last in the builder, or created, imported or copied it), the number of
  **working copies** (a link to them) and a **lock icon** with its owner when the application is locked; the cards show
  them as small badges. *Updated* is now the later of that change and the application's settings, so a change to a
  page moves it too. Recorded in the new table `meta.app_change` (builder state of the installation: not exported,
  kept by `pgkiln import --replace`, closed to the runtime). Works without JavaScript and on phones.
- **File-level import** (APEX 26.2: APEXlang file-level import): `pgkiln import <dir> --replace --only pages/12`
  (or `--only shared/lovs/jobs.yaml`, repeatable) imports one page or shared component from a directory export (or
  .zip) and leaves the rest of the application as it is ([chapter 18](docs/guide/18-cli.md#importing-one-page-or-component)).
- **Pillar navigation appearances** (WS-10; APEX 26.2 Universal Theme): Theme Roller → *Navigation appearance*
  **Pillar Light** (header and menu on the page's own surfaces) or **Pillar Dark** (header and menu as one dark column),
  for the application or per style, with a **header pillar strip** colour for light and dark mode (per style also from an
  item) and the current page as a filled pill; the Theme Roller's preview has a sample menu. Stored in `meta.app.theme`
  (`appearance`, `strip`, `strip_dark`), so it travels with export and import. No migration.
- **Subtle colour utilities** `u-color-1-subtle` … `u-color-15-subtle` and `u-color-{success,danger,warning,info,neutral}-subtle`:
  tinted backgrounds with AA-contrast text in light and dark mode.
- **Mail queue, a workspace's own mail service and network access** (WS-9; APEX 26.1 / 26.2 Administration;
  migration 126): Administration → **Mail queue** shows queued, sent, failed and retrying mail per hour and per
  workspace / application, the slowest provider calls and the failures with the provider's answer (e.g. the SMTP
  reply), with **Retry** and **Purge** (administrators: every workspace; a workspace's administrators: their own).
  A workspace's administrators can set up the workspace's **own mail service** (any provider, the secret encrypted
  and write-only; its applications without a service of their own send through it). Administration → **Network
  access**: a workspace's list of hosts (`api.example.com`, `*.example.com`, `host:port`) narrows
  `PGKILN_REST_ALLOWED_HOSTS` for every outgoing web call of its applications (`meta.web_request`, REST data
  sources, invoke API, token endpoints, object storage, REST source catalogs), on every redirect hop; refused calls
  go to the debug log and a *Refused calls* list. `meta.mail_queue` records each attempt's provider and duration.

### Changed
- `docs/apex-feature-parity.md` compares with **APEX 26.2**: a new section for the 26.2 workspace items WS-1 … WS-13
  (eight done, five open) and OCI managed identities (not planned); stale rows on facet menus, Comment Out and
  blueprints fixed. 163 features compared, 94% available.
- The navigation menu tells the current page (filled, accent bar) from its parent entries (bold, not filled, an accent
  guide line along the open sub-menu) at a glance; keyboard focus is a ring inside the menu.
- Right to left (Arabic, Hebrew, …): the menu and drawer, guide lines, chevrons, menus and reflowed report cards are
  mirrored (logical CSS properties).
- A lighter processing indicator: busy regions dim slightly after 150 ms and show a thin moving bar; a lighter wait
  popup spinner.

### Fixed
- A theme or style with both an accent and a header colour wrote them as one malformed CSS declaration, so the header
  colour (and the soft accent) were ignored.
- The top navigation's sub-menus used the page surface behind the menu's text colour (unreadable with Iris's dark menu).

### Security
- *REST source catalogs → read from a URL* fetched the URL before the developer's session and CSRF token were
  checked; it now reads it only afterwards, within the current workspace's network access list.
- A workspace's mail service has no API base URL or token URL, and its SMTP host must pass the installation's
  allow-list and the workspace's list and resolve to a public address (connected to by the checked address).

## [0.52.0] - 2026-10-19

### Added
- **Component details** (WS-11; APEX 26.1; migration 124): the **popup LOV** dialog loads the next page as the list
  scrolls, so long lists scroll to their end without a More button (browsers without IntersectionObserver still page
  with ‹ / More; without JavaScript it is still a select list). New dynamic actions **Wait Popup** / **Remove Wait
  Popup** (`wait_popup`, `remove_wait_popup`): a modal, accessible "please wait" dialog around long processes and Ajax
  calls, also `pgkiln.waitPopup()` in JavaScript. Menu buttons: entries `{"label", "action": "NAME"}` run dynamic
  actions of the new event **Menu entry chosen** (`menu_entry`); the Page Designer shows the event, plus an "Other"
  folder for the remaining events. HR example `hr_68` (page 47 "Component details").
- **Workflow 26.2** (WS-6; APEX 26.1 / 26.2; migration 123): task definitions may list **custom outcomes** (for
  example Yes / No / Undecided, each with a label and a colour from a fixed list) instead of Approve / Reject; workflows
  branch on them in a task step's `next` or a switch case `{"outcome": …}`. **Task events** run when a task is
  completed, expires or its completion SQL fails: SQL as the application's role, an e-mail, or start a workflow; *When
  the completion SQL fails* reopens the task (default) or keeps it completed. **Notifications** send e-mail templates
  when a task is created, completed or expires. New steps: **Send E-Mail** (`send_mail`) and **draft** placeholders,
  which only a development version may hold (Activate is refused). **Migrate running instances** to a newer version of
  the workflow with a step mapping, a preview, one transaction and a log (instances inside open parallel branches
  can't be migrated yet). The workflow diagram downloads as **SVG** or **PNG**. HR example `hr_67`.
- **Team Development** (WS-3; APEX: Team Development; migration 122): Builder → Team Development tracks a workspace's
  issues with labels (in groups, colours from a fixed list), milestones, assignees, links to applications and pages,
  Markdown comments with @mentions shown in the builder, and a history of changes. A filtered list with saved views
  and a board by label group or milestone work without JavaScript. A set-up wizard installs sample labels (Bug,
  Feature, Task; High, Medium, Low), issue templates, canned responses and milestones. *Make an issue* turns users'
  feedback and developer comments into issues. The Page Designer, App Home and the Workspace home show open issues.
  Issues, labels, milestones and templates travel in the workspace export (part *team*). HR example `hr_66`.
- **AI interactive reports** (WS-5; APEX 26.1 / 26.2): "Ask in your own words" on an interactive report now sets all
  of the report's settings: filters, highlights, search, sort, control break, totals, group by, pivot, chart and
  computed columns ("bonus is 10% of salary", checked like Actions → Compute). Each setting shows as a chip with Edit
  and Remove, and Undo goes back a step (five steps, kept in the session); it all works without JavaScript. Without
  an AI service (`"ai_filter": {}`, or when the service isn't available) a built-in parser understands common
  English, Dutch and German phrases such as "sum of salary by department where job is clerk". Answers are checked
  against the report's shown columns and fixed lists; values are bound or escaped. HR example: the employee
  report on page 2 (`hr_65`). The box now shows even when no AI service is set.
- **AI Agents** (WS-4; APEX 26.1 / 26.2; migration 121): Shared Components → AI Agents. An agent combines an AI
  service, a system prompt, a reasoning effort (low / medium / high, mapped to each provider), approved tools, step
  and token limits and an authorization scheme; an AI assistant region can name one (`{"agent": "NAME"}`). Tools:
  SQL queries (a read-only transaction as the application's role through row level security, with a time limit),
  PL/pgSQL functions, REST data sources, JavaScript actions in the browser, and **Navigate** links to pages the user
  may open, whose URL and checksum pgkiln builds. Agents and tools export with the application.
- Every AI tool call is logged with its arguments, status and duration (debug level 4 and Activity → AI usage →
  Tool calls; kept 30 days, developers only).
- AI services: **Gemini** and any **OpenAI-compatible** endpoint (Ollama, vLLM, Azure OpenAI); optional instance
  defaults `GEMINI_API_KEY` and `OPENAI_COMPATIBLE_API_KEY`. HR example: page 46 "HR agent" (`hr_64`).

### Fixed
- Workspace home: the System message no longer touches the Activity regions above it.
- **Docker upgrades:** `docker compose pull` in `deploy/` skipped the pgkiln image once one was present, because
  `pull_policy: missing` stood next to `build:`; upgrading with `docker compose pull && docker compose up -d` kept
  the old `:latest`. The line is gone. In a `compose.yaml` copied from 0.51.0 or older, delete it yourself. CI now
  upgrades a running 0.50.0 container this way.

## [0.51.0] - 2026-10-19

Sprint 109: the Workspace home (parity handoff WS-1). Sprint 110: Data Reporter as a workspace tool (WS-2).

### Added
- **Workspace home** (WS-1; APEX: the workspace home page; migration 119): after signing in the builder opens
  `/builder/home`: cards for App Builder, SQL Workshop, Data Reporter and the App Gallery; the workspace message,
  edited in place by the workspace's administrators; a Summary of applications, tables, developers and reporting
  applications that link to their tool; top applications, users and developers over 1 hour, 1 day or 1 week
  (remembered per developer); a System message with the server's version; Learn more and Resources. Works without
  JavaScript.
- **Release check** (off by default): with `PGKILN_RELEASE_CHECK=on`, or *Instance settings → New versions* in the
  builder, the server asks GitHub's releases API at most once a day (5-second timeout, 1 MB, nothing sent about the
  installation) and the Workspace home shows *pgkiln X is available* with the release notes and how to upgrade.
- **Data Reporter as a workspace tool** (WS-2; APEX 26.1; migration 120): App Builder → **Data Reporter**
  (`/builder/reporter`) keeps **datasets** (`meta.dataset`): tables and views of one schema with joins proposed from
  foreign keys, the offered columns with labels, format masks and descriptions, and a row filter, checked against
  the database when saved, with a query preview. Datasets download and import as `*.dataset.json` files and travel
  in the workspace export. **Create reporting application** makes an application of type *Reporting* on one or more
  datasets in two clicks: its role may only SELECT the datasets' tables and views, so every report runs through
  those grants and RLS; viewers open published reports, editors build and publish them, administrators moderate.
- Data Reporter region: a dataset as a source; `edit_authz`, `admin_authz` and `publishing` (published reports with
  a stable URL `/a/<alias>/reports/<id>`, Publish / Unpublish, pins per user). HR example `hr_63_datasets.sql`.

### Changed
- The App Builder's home moved to `/builder/apps`. `/builder` still shows it unless the workspace's preferences
  (*Builder links open*) send it to the Workspace home; the logo and the rail's Home lead to the Workspace home.

## [0.50.0] - 2026-10-18

Sprint 107: a transaction mode in the SQL Worksheet (parity handoff DA-2, the rest).
Sprint 108: the builder look, part 2.
DA-18: JavaScript (MLE) stays not planned; plv8 where installed (docs only).

### Added
- **Transaction mode in the SQL Worksheet** (DA-2; beyond Database Actions, which commits every statement): switch a
  worksheet tab from *Autocommit* to *Transaction* to keep its statements in one transaction until **Commit** or
  **Rollback**. A badge shows the open transaction, its statements and its age, or why the server rolled it back.
  Ctrl+Enter and Run Script use a database connection pinned to the tab (never pooled, bound to the builder session and
  workspace). The transaction is rolled back after `WORKSHEET_TXN_IDLE_SECONDS` without a run (default 300), on
  sign-out, when its session expires, on a workspace switch, when its tab is closed or switched back to Autocommit,
  and when the server stops; `idle_in_transaction_session_timeout` is set as a backstop. Typed `COMMIT` / `ROLLBACK`
  end it; statements that cannot run in a transaction (VACUUM, `CREATE INDEX CONCURRENTLY`, …) are refused; an error
  leaves it aborted until Rollback. Explain Plan and Autotrace run inside it behind a savepoint; its DDL reaches the
  Change Log at COMMIT. *Run as* stays fixed while the transaction is open. Limits: `WORKSHEET_TXN_MAX_PER_DEVELOPER`
  (3) and `WORKSHEET_TXN_MAX` (20). The transactions live in the server's memory: several servers need sticky
  sessions. Without JavaScript the worksheet runs in Autocommit.
- **Highlighted read-only SQL**: Object Browser DDL and source, the Data Modeler's DDL, the SQL that Quick SQL, the
  Query Builder, Scheduling, Database Users and the table editor generate, SQL Monitor statements, chart queries and
  the Change Log use the code editor's colours. The code editor marks the current line.

### Changed
- **Builder look, part 2** (sprint 108): the code editor's syntax colours are tokens of the builder's theme (ember
  keywords; every token kind at least 4.5:1 in light and dark). The Data Modeler's boxes, lines and mini-map follow
  the dark theme (exports stay light); polish for the Object Browser tree, the wizards' icon picker and colour field
  and the SQL Monitor's refresh controls.
- In Autocommit, a `BEGIN` left open at the end of a worksheet run is rolled back with a warning under Notices
  (it was rolled back silently).

### Fixed
- The worksheet's success and error colours were hard to read in dark mode; its splitters and worksheet tabs have
  correct ARIA. The Data Modeler's mini-map showed white boxes in dark mode.

## [0.49.0] - 2026-10-16

**Upgrade note:** REST module handlers now refuse (403) to run as a superuser, a role that bypasses row level security
or a member of pgkiln's owner. An application without its own database role on an installation where
`RUNTIME_DATABASE_URL` is not set is affected. Run the Advisor after upgrading; give the application its own database
role or set `RUNTIME_DATABASE_URL` (details under *Changed*).

Sprint 101: Scheduling with pg_cron (parity handoff DA-12).
Sprint 102: the SQL Monitor (parity handoff DA-14).
Sprint 103: Schema Export / Import (migration 116; parity handoff DA-16).
Sprint 104: RESTful Services modules, templates and handlers (migration 117; parity handoff DA-11, part 2).
Sprint 105: a refreshed builder look.
Sprint 106: the change log of DDL change sets (migration 118; parity handoff DA-17).

### Added
- **Scheduling** (DA-12; Database Actions: Scheduling; administrators only): SQL Workshop → *Scheduling* lists
  pg_cron's jobs with the schedule in words, the next run (in `cron.timezone`), the last run and recent failures.
  Create and edit a job with a schedule builder that previews the next five runs (also without JavaScript); the SQL
  (`cron.schedule_in_database`, `cron.alter_job`) is reviewed, then applied in one transaction. Disable / Enable,
  Unschedule, and *Run now*: pg_cron has none, so pgkiln runs the job's stored command once in its database as its
  role (recorded in the activity log, not in pg_cron's history). The run history has filters and a reviewed purge.
  Without pg_cron the page says what is missing and how to install it, and lists pgkiln's own automations and
  process jobs read-only.
- **SQL Monitor** (DA-14; Database Actions: Real Time SQL Monitor; administrators only): SQL Workshop → *SQL Monitor*
  shows the live sessions with state, wait event, running time and who blocks whom, a summary of wait events and the
  progress of VACUUM, ANALYZE, CREATE INDEX, CLUSTER and COPY, refreshed in place every 5, 15 or 60 seconds with
  *Pause* (a Refresh link without JavaScript). *Cancel* and *Terminate* a session with confirmation. *Top SQL* covers
  the whole database from `pg_stat_statements` with total and mean time as bars, sort by any column, search and
  *Reset statistics*. A statement's page shows its totals per role, its Explain Plan as a tree (`EXPLAIN` only, in a
  read-only transaction; a generic plan for `$1` parameters on PostgreSQL 16+) and *Open in worksheet*.
- **Schema Export / Import** (DA-16; Database Actions: Data Pump; administrators only): SQL Workshop › *Schema
  Export / Import* runs `pg_dump` of one schema (custom or plain format, definitions and / or data, grants, tables
  included or excluded) as a background job with its log, size, duration, Download, Cancel and Delete, and imports a
  one-schema custom or tar archive (uploaded, or a kept export) into a new or existing schema. The import is
  previewed from `pg_restore --list` and run by pgkiln on one connection in one transaction; every statement must
  stay inside the dump's schema (roles, `SET ROLE`, `OWNER TO`, `DO`, extensions, COPY to files or programs are
  refused). Importing under another name renames the original aside and back before commit; names inside
  PL/pgSQL bodies keep the old schema. Jobs are kept in `meta.dump_job` (migration 116), files in
  `PGKILN_DUMP_DIR` for `PGKILN_DUMP_KEEP_DAYS` days (default 7), uploads up to `PGKILN_DUMP_MAX_MB` (2048);
  `PGKILN_PG_BIN` points at the client programs, which must be at least as new as the server. A dump's functions
  and triggers run as pgkiln's owner role: import only dumps you trust.
- The Docker image includes PostgreSQL 17's client programs (`pg_dump`, `pg_restore`) and a `dumps` volume.
- **RESTful Services modules** (DA-11 part 2; Database Actions / ORDS: REST › Modules): SQL Workshop › RESTful
  Services › *Modules* edits an application's REST modules as a tree of module (base path) › templates (URIs with
  `:parameters`) › handlers (method and source type). New source types: **PL/pgSQL** (a block run as a `DO`
  statement; binds are read through `meta.rest_param()`, set as transaction-local settings with query parameters,
  and `meta.rest_reply(body, status)` answers) and **media** (a row's `content_type` and `content`, served
  sandboxed). A module's **privilege** (roles every handler needs), template descriptions and documented handler
  parameters (query or body, type, required: a missing one answers 400) go into the module's OpenAPI document. Each
  handler has a **Try it** panel that calls the real endpoint without a token or with a short-lived token of an
  account of the application. Modules travel with the application's export (migration 117 adds
  `meta.rest_module.roles` and `.templates`). The HR example has a module `hr` (`examples/hr/hr_62_rest_module.sql`).
- **Change Log** (DA-17; Liquibase / Flyway): DDL that succeeds in the SQL Worksheet, *Apply* in Table Properties and
  the new *Apply and record* of Schema Comparison (the change script in one transaction) are recorded as change sets
  per workspace and schema: author, time, SQL, where from, the object and a number that is never reused
  (`meta.change_set`, `meta.change_set_counter`, migration 118). SQL Workshop › *Change Log* lists them per schema,
  renames and deletes them, marks those made after the latest builder export of an application of the workspace, and
  downloads them as Flyway versioned files (`V0001__add_bonus.sql`, several in a zip), a Liquibase formatted SQL
  changelog or a plain script (all, not yet written, or after the latest export). Only schema DDL is kept: no data
  changes and no role, database or server statements (no passwords). The builder's Export is logged as `app_export`.

### Changed
- The Utilities' *Database Monitor* is replaced by the SQL Monitor; its address redirects.
- **Builder: refreshed look** (sprint 105): a design token layer in `public/builder.css` (colour, surface elevation,
  radius, shadows, type scale and motion as CSS custom properties, a full light and dark set) with a warm "stone"
  palette and the kiln's ember as the brand and primary colour. A flame brand mark replaces "pg" in the rail and on the
  sign-in pages; the rail has rounded items with an ember marker for the current section and smoother tooltips; the
  toolbar has a dark search field with its icon. Regions, tiles and cards have rounder corners, subtle shadows and a
  lift on hover; buttons, fields (a focus ring), selects (one chevron in both themes), segmented controls, tabs,
  menus and reports (quiet uppercase headers that stick inside a scrolling table, row hover, neutral links) are
  restyled; the page designer's canvas has a dot grid and softer selections. Transitions are off under
  `prefers-reduced-motion`. No markup contracts change; system fonts (Inter when installed), no new dependencies.
- **Upgrade note:** REST module handlers refuse to run (403) when the role they would run as is a superuser, bypasses
  row level security or is a member of pgkiln's owner. This affects an application without its own database role on an
  installation where `RUNTIME_DATABASE_URL` is not set (or points at a privileged role): such handlers ran with full
  rights and ignored row level security. Fix: give the application its own database role, or set
  `RUNTIME_DATABASE_URL` to the least-privilege runtime role. AutoREST (sprint 100) already refused this. The Advisor
  reports an affected application as an error (run it after upgrading) and compiles PL/pgSQL handlers.

## [0.48.0] - 2026-10-16

Sprint 96: the SQL Workshop's Launchpad and the builder's search (migration 109; parity handoff DA-15).
Sprint 97: charts of a query (migration 110; parity handoff DA-6).
Sprint 98: the Data Modeler (migration 111; parity handoff DA-10).
Sprint 99: Administration → Database Users (parity handoff DA-13).
Sprint 100: RESTful Services, tables and views as REST endpoints (migration 113; parity handoff DA-11, part 1).

### Added
- **The Launchpad** (DA-15; Database Actions: the Launchpad): the SQL Workshop home starts with *Pinned & recently
  visited* (pins per developer and workspace in `meta.builder_pin`, migration 109: tools, Object Browser objects,
  saved worksheets; recent pages kept in the browser), then the tools in tabs *Development*, *Administration* and
  *Monitoring* with a description and a pin each. The *More* menu uses the same headings.
- **Charts** (DA-6; Database Actions: Create Chart and Charts): the worksheet's *Chart* tab (Ctrl+F11) draws the last
  query (type, label and value columns to choose); *Save chart* keeps it (`meta.sql_chart`, migration 110) and SQL
  Workshop → *Charts* lists the saved charts with a dashboard; a saved chart's query runs read-only.
- **Data Modeler** (DA-10; Database Actions: Data Modeler): SQL Workshop → *Data Modeler* keeps named relational
  diagrams of a schema's tables and views (`meta.sql_diagram`, migration 111; positions only, the columns and keys
  come from the catalog). Boxes show columns, types, primary, foreign and unique keys and not null; foreign keys are
  lines with crow's feet (dashed when optional). Add objects by search (`*` for all), drag and save positions,
  undo / redo, zoom, fit, auto layout, a mini-map; export SVG or PNG, print; Generate DDL of the shown objects and a
  data dictionary (HTML); a box opens Table Properties. Without JavaScript the diagram is a server-drawn SVG.
- **Database Users** (DA-13; Database Actions: Database Users; administrators only): Administration → *Database
  users* lists the PostgreSQL roles with sign-in, attributes, connection limit, expiry, memberships and what they
  own, with filters for passwords expiring within 30 days, BYPASSRLS roles and group roles that own objects. Create
  and change roles (login, password, valid until, connection limit, member of, search path, schema usage and create,
  default and existing-table privileges): the SQL is reviewed with the password masked, then applied in one
  transaction. Passwords become SCRAM-SHA-256 verifiers in pgkiln and are never shown or logged. Drop a role after
  reassigning or dropping what it owns. pgkiln's own roles are read-only; roles used by applications or workspaces
  can't be dropped.
- **RESTful Services** (DA-11, part 1; Database Actions: REST › Enable, AutoREST): SQL Workshop → *RESTful
  Services* publishes a table or view through an application at `/a/<alias>/autorest/<object>/`: GET returns rows
  paged with `limit` / `offset`, with `?column=` filters, `?q=` search and `?order=`; GET, PUT and DELETE by primary
  key; POST inserts. Requests run as the application's database role (never the owner or a role that bypasses row
  level security) with the application's tokens, OAuth clients and roles; public access is an explicit choice. An
  OpenAPI description per application; the object's page shows grant and RLS checks with cURL and fetch examples.
  Tables and views have *REST › Enable / Disable* in their ⋯ menu (`meta.rest_object`, migration 113, installation
  data, not exported).
- **Search** (**Ctrl/Cmd + K**, or the header's field on every builder page): tools, applications, pages and
  database objects by name; a page of results without JavaScript.

## [0.47.0] - 2026-10-16

Sprint 91: the SQL Worksheet like Database Actions' SQL (parity handoff DA-1, DA-2).
Sprint 92: the worksheet's Query Result, plans and history (migration 108; parity handoff DA-3, DA-4, DA-5).
Sprint 93: worksheets as files and tabs, editing tools and bind variables (parity handoff DA-7, DA-9).
Sprint 94: an object's menu in the worksheet and the Object Browser (parity handoff DA-8, part 1).
Sprint 95: Table Properties (parity handoff DA-8, part 2).

### Added
- **The SQL Worksheet** (DA-1; Database Actions: SQL): SQL Commands becomes one screen with a **navigator** (schema,
  object type, search; tables and views open to their columns, drag one into the editor for a SELECT, or insert its
  SELECT / INSERT / UPDATE / DELETE), the editor with a toolbar, **output tabs** (Query Result, Script Output,
  Notices, Explain Plan, Autotrace, SQL History) and a **status bar** with error and warning counts. The panes fill
  the window and resize (mouse or arrow keys, remembered), the navigator hides, and Fullscreen shows only the editor.
  `/builder/sql/worksheet`; `/builder/sql/commands` is the same page, and the SQL Workshop's tabs start with it.
- **Run Statement and Run Script** (DA-2): Ctrl+Enter runs the statement at the cursor (or the selection) and
  selects it again; F5 runs every statement with a log per statement (psql's command tags such as `CREATE TABLE`
  and `INSERT 0 2`, the rows as text, notices, an error's line and column), stopping at an error unless *Continue on
  error* is on. `COPY … FROM STDIN` and psql commands are skipped. F10 shows the statement's plan, F6 runs it with
  `EXPLAIN ANALYZE` and rolls it back.
- **Run as** an application of the workspace: the worksheet's statements run as its database role with
  `pgkiln.app_id` set, so its row level security applies.
- **Query Result** (DA-3): numbers right-aligned, sort by a column, a cell's whole value in a dialog (JSON indented),
  Copy as tab-separated text, *All rows* (up to 10,000), and **Download** as CSV, JSON, XML, Excel or SQL inserts.
- **Plans as a tree** (DA-4): Explain Plan and Autotrace show the steps with cost, rows and conditions; Autotrace
  adds actual time, rows, loops, buffers and each step's own time, marks the slowest step and estimates that are
  10× off; the text plan is one click away.
- **SQL History** (DA-5, migration 108 `meta.sql_history`): per developer and workspace, each statement with how
  it ended, its rows and time; a repeat counts on its row; search, filter by status, run again, copy. Notices show
  their time.
- **SQL inserts** as an Unload Data format.
- **Worksheets as files** (DA-7): Save (Ctrl+S), Save as new, Rename and Download a worksheet as a script of SQL
  Scripts; New and Open; a **Files** tab in the navigator; several worksheets as **tabs** whose unsaved text survives
  a reload (kept in the browser); SQL Scripts opens a script in the worksheet.
- **Editing tools** (DA-9): Format (Ctrl+F7, keywords in lower or UPPER case), Convert case (Ctrl+B), find and
  replace with regular expressions (Ctrl+F, Ctrl+H), Go to line (Ctrl+G), comment lines (Ctrl+/), a list of the keys,
  Help (F1), and Load Data for the navigator's schema.
- **An object's menu** (DA-8; Database Actions: the navigator's context menu): ⋯ (or right-click) on an object in
  the worksheet's navigator or the Object Browser's tree: Open in a side panel, Quick DDL into a new worksheet tab or
  as a file, Load data, Add index / trigger / policy, and Drop… with what depends on the object. Every statement goes
  into the worksheet to review; nothing runs.
- **Table Properties** (DA-8; Database Actions: Edit table): create a table, edit one or use one as a template in
  a form (columns with type, key, not null, default, identity and comment; unique keys, foreign keys, checks,
  indexes, comment, row level security, partitioning for a new table). Preview DDL shows the CREATE or ALTER
  statements made against the catalog; Apply runs them in one transaction; or open them in the worksheet.
- **Bind variables** (`:NAME`, bound as quoted literals) and **substitution variables** (`&NAME.`) are asked for in a
  dialog before a run, and remembered for the session.

### Changed
- Unload Data puts the session's schema first in the search path, like the worksheet.
- The SQL Workshop's "SQL Commands" is called the **SQL Worksheet** everywhere (tiles, tabs, *Run in the SQL
  Worksheet* in the Query Builder and AI). Each statement now commits on its own; before, several statements ran
  in one implicit transaction.

## [0.46.0] - 2026-10-15

Sprint 84: facet menus and the date picker (parity handoff GEN-9, IR-4).
Sprint 85: the Form Designer (migration 106).
Sprint 86: builder addresses and error pages (parity handoff BLD-6).
Sprint 87: the Create Application wizard (parity handoff WIZ-4).
Sprint 88: the generated home page and the page footer (migration 107; parity handoff GEN-4).
Sprint 89: the Object Browser (parity handoff SQL-4).
Sprint 90: the page designer's Comment Out and gallery labels (parity handoff PD-4).

### Added
- **A checkbox facet's ⋮ menu** (GEN-9; APEX: the facet's menu): *Clear*, and the values *Sort by count* (the
  default) or *Sort by name* (`r<report id>_fo_<column>=name`, kept by Apply and Reset).
- **The date picker** (IR-4; APEX: the date picker): pgkiln's own month of days under a date field, with keys
  (arrows, Page Up/Down, Home/End, Enter, Escape), the language's first day of the week, *Today* and *Clear*.
- **The Form Designer region** (`form_designer`; beyond APEX): the application's administrators build data entry
  forms in the running application. The developer offers tables and views in the region's settings (columns with
  labels and lists of values, the key column, whether forms may add, change or delete rows) and names the
  authorization scheme designers pass; designers pick fields (order, label, help, required, display, default for new
  rows) and the columns of the row list, and publish the form. Rows are read and written as the application's
  database role (grants and row level security apply), with lost update detection; definitions are checked against
  the region's settings before they run. Forms are kept in `meta.user_form` (the view `meta.user_forms`,
  `meta.save_user_form`, `meta.delete_user_form`): installation data, not exported, kept when an application is
  replaced. HR example page 45 (*Forms*).
- **The page designer by the page's number** (BLD-6): `/builder/apps/<app id>/pages/<page number>` (with
  `?c=…` for the selected component); the builder's links, the developer toolbar's *Edit page* and *Quick edit*
  use it, and a browser that opens the internal `/builder/pages/<id>` is redirected there.
- **HTML error pages in the builder** (BLD-6): *Page not found* and *Something went wrong* for a browser under
  `/builder`, in the builder's theme, instead of JSON or plain text (scripts keep the plain answers).
- **An application's version** (GEN-4; APEX: Version, migration 107): Settings → Definition; new applications start at
  *Release 1.0*. It travels with the export.
- **A page footer** (GEN-4): the version (translated like other application texts) and *Back to top*, under the
  content of every page.
- **Modify column** (SQL-4; APEX: the Columns toolbar): a new type, nulls allowed or not, a default or none, written as
  one ALTER TABLE into SQL Commands to review; the column actions are a toolbar above the columns (Add, Modify,
  Rename, Drop).
- **Comment out / Uncomment** in the page designer tree's menu (PD-4; APEX: Comment Out): the component gets the build
  option `COMMENTED_OUT` (status *Exclude*, made when first needed) and is struck through in the tree.

### Changed
- **Dates in the date format everywhere** (IR-4): date range items, interactive grid date cells, a faceted search's
  custom date range and the task list's vacation rule are text in the application's date format with the date picker, like date items; without a date
  format, `YYYY-MM-DD`. No browser date fields are left for dates (timestamps keep the browser's date and time field).
  The calendar button no longer opens the browser's picker.
- Values a browser kept under pgkiln's old name (`pgapex.*` in localStorage and sessionStorage, `pgapex-push:*`)
  move to `pgkiln.*` once, and the service worker deletes its old `pgapex-*` caches (BLD-6).
- **Choosing a schema reloads the Pages list in place** (WIZ-4): the tables of the schema, with the name and alias
  proposed for it while you haven't typed them; *Show its tables* stays for pages without JavaScript.
- **Row level security before Create** (WIZ-4): a table with RLS shows *RLS · n* (its policies), or *RLS, no
  policies* in red (the application's role would see no rows).
- **The alias follows the name until you change it** (WIZ-4), and **First user / Password hide for authentication
  None** (WIZ-4).
- **Home page cards** (GEN-4): a list's *cards* template gives each card a colour band and its icon in a round badge,
  in the chart palette's order; the **hero** region sits on the page background instead of a tinted panel.
- **The Object Browser's schema** (SQL-4): the one chosen last (per session), else the session's schema, else the
  parsing schema of the application changed last in the workspace.
- **A table's tabs on one row** (SQL-4): Columns, Data, Indexes, Constraints, DDL and the current tab; the rest under
  *More*. **NULL is a blank cell** in the Object Browser, not an italic *null*.
- **The gallery's labels in title case** (PD-4; APEX's): *Interactive Report*, *Faceted Search*, *Login*, *Text Field*, …; long
  labels wrap instead of being cut off, and the full name is the tooltip.

## [0.45.0] - 2026-10-15

Sprint 80: master-detail and grid cells like APEX's (parity handoff GEN-8).
Sprint 81: Application Computations and Shortcuts in Shared Components (migrations 102–103; parity handoff BLD-2).
Sprint 82: Report Queries in Shared Components (migration 104; parity handoff BLD-2).
Sprint 83: Component Settings and Component Groups in Shared Components (migration 105; parity handoff BLD-2).

### Added
- **Component Settings** (Shared Components → User Interface; APEX: Component Settings): an application's defaults
  for reports' and interactive grids' rows per page, popup lists of values' rows per page, the rows a list of values
  reads and a star rating's stars, used where a component sets nothing itself (`meta.app.component_settings`).
- **Component Groups** (Shared Components → Other Components; APEX: Component Groups): a library or theme
  application's set of components (`kind:name`); another application subscribes to all of them at once on its
  Subscriptions page (`meta.component_group`, exported, `shared/component-groups/`).
- **Report Queries** (Shared Components → Files and Reports; APEX: Report Queries): a named query printed as PDF
  (with a report layout), Excel, CSV, JSON, XML or HTML; any page downloads it with `?doc=NAME` (a document template
  of that name wins), a *document* button names it; its own authorization (`meta.report_query`, migration 104).
  Exported with the application, as files in `shared/report-queries/`.
- **Application Computations** (Shared Components → Application Logic; APEX: Application Computations):
  computations of items for every page, at sign-in (`after_authentication`), before every page (`before_header`)
  or after every submit (`after_submit`), before the page's own computations; the types, conditions,
  authorization and build option of a page computation (`meta.app_computation`, migration 102).
- **Shortcuts** (Shared Components → Other Components; APEX: Shortcuts): named texts (text, HTML, or a PL/pgSQL
  function body); `"NAME"` in a static region's content, an item's help and a button's or menu entry's confirm
  message is replaced by the shortcut, before `&ITEM.` substitutions (`meta.shortcut`, migration 103).
- Both are exported with the application, as files in `shared/app-computations/` and `shared/shortcuts/`.

### Changed
- **Master-detail** (GEN-8): the page opens with the master grid's first row selected, so the details show its
  rows (they said *Select a row above*); a search or filter that leaves the selected row out selects the first
  row it shows.
- **Interactive grid cells** (GEN-8): with JavaScript an editable cell reads as text, with its column's format
  mask (*2,850.00*, was the raw *2850*) or the list's display value, until it is clicked, or Enter, F2 or typing
  edits it; the arrow keys move between cells, Escape leaves the cell's editor and Enter moves to the cell below.

### Fixed
- An HTML file a download process or report query sends keeps its own `Content-Security-Policy` (`default-src
  'none'; sandbox`); the page's policy replaced it.
- `meta.data_export` refused a query with a column named `q` or `x` (the names of its own aliases).

## [0.44.0] - 2026-10-15

Sprint 78: generated reports and grids read the same (migration 100; parity handoff GEN-2, GEN-1, GEN-7, GEN-9).
Sprint 79: the runtime chrome, the report toolbar and the dashboard like APEX's (migration 101; parity handoff UI-2, UI-3, UI-4, IR-3, GEN-6).

### Changed
- **Faceted search pages** made by the wizards show one column per foreign key: the parent's name under
  the key's label (*Manager*: KING). The key is hidden (still in the query for filters and links); before,
  both showed and the report had two *Manager* and two *Department* columns. Its number columns get
  format masks (*2,850.00*), like the report and form pages.
- **Interactive grids** made by the wizards (the grid page, both grids of a master-detail page) get friendly
  headings (*Department Number*, *Hire Date*, not *Deptno*, *Hiredate*) and number format masks;
  a map page's list report gets the masks too. `meta.wizard_grid_labels(table)` returns both.
- The **Create Application** wizard's page list names each table's pages (*Employees*), with the table's
  name as secondary text.
- **Faceted search** (GEN-9): the panel starts with the *Total row count* the filters leave; a checkbox facet
  shows seven values and the rest under *Show all (n)*; a boolean's values read *Yes* and *No*, not
  *true* and *false*; with the panel's search field the report shows no search field of its own (its
  Actions menu stays), so the page has one.
- **Light or dark** (UI-2): until a user chooses, an application opens in its own mode (a new Iris
  application light, also when the device is dark). Accounts started with *Automatic* as their choice, so
  at sign-in every Iris application followed the device; `meta.account.theme_pref` is now null until the
  user chooses (migration 101 clears the old default; a user who chose *Automatic* chooses it again). A
  signed-out user's choice is a cookie of that application only (`pgkiln_mode`, path `/a/<alias>`), no
  longer one cookie for every application on the host.
- **User menu** (UI-3): signed out on a public page of an application with sign-in, the header has a user
  menu with *Appearance* and *Sign in* (was a *Sign in* link only); the Appearance menu of an application
  without sign-in has a tooltip.
- **Developer toolbar** (UI-4): each tool shows a short text next to its icon: *App 12*, *Page 3*,
  *Debug off*/*on*… (icons only on narrow screens, docked at a side, or with the new *Icons only* setting).
- **Report search** (IR-3): the column scope is the magnifier at the start of the search field (the
  column's name once one is chosen); Enter searches and the *Go* button shows only without JavaScript.
  A generated faceted search report's rows start with a pencil that opens the form; the key is plain text.
- **Generated dashboards** (GEN-6): a chart sums a table's amount column when it has one (*Salary by
  Department*), else counts rows; six groups or fewer make a donut, a date a line, else a sorted bar; a
  grouping that says nothing (one group, or every group the same) is left out (the next foreign key or
  repeating column is tried).

### Fixed
- The pager's *Rows per page* label stays on one line (IR-3).
- **Rows per page** in an interactive report's pager: its GET form sat inside the page's form, so the browser
  dropped it; the select then belonged to the page's form (changing it posted the page) and stretched across the
  region. The form is now detached like the toolbar's forms; the select and its button join it by its id.

## [0.43.0] - 2026-10-14

Sprint 74: the builder's information architecture like APEX's.
Sprint 75: the SQL Workshop's Object Browser like APEX's.
Sprint 76: the interactive report's menus like APEX's, and date items in the application's date format.
Sprint 77: the Page Designer's layout and tree by display position, like APEX's (migration 099).

### Added
- **Shared Components as a grid** (APEX): ten groups of component types with counts; each type opens a list with
  search (filtering while you type), sort and Create; Settings-backed types (authentication, PWA, globalization,
  navigation bar list, user interface attributes) open their Settings tab; **Breadcrumbs** (the pages by their
  breadcrumb parent). The earlier page stays as *Tree view*. The parity matrix maps every APEX Shared Components
  link to pgkiln (or *not planned*).
- **Settings in tabs**: Definition, Security, Sign-in, User Interface, Globalization, Errors and Sessions,
  Progressive Web App; Save returns to the tab; the authentication type shows only its own fields.
- **Application home**: search by page name or number, a Report / Icons view, Create page, and a Tasks sidebar.
- **Object Browser by object type**: a schema in the header (the session's schema by default), folders for tables,
  views, materialized views, indexes, sequences, types, functions, procedures and triggers, a filter, a Create menu
  and create tiles that start a CREATE statement in SQL Commands. pgkiln's schemas and extension objects show only
  with *Show system objects*.
- **A table in tabs**: Columns, Data (paged), Indexes, Constraints, Triggers, Grants, Row level security,
  Dependencies, Statistics and DDL. Add, rename and drop column write the ALTER TABLE statement into SQL Commands to
  review and run.
- **Column heading menu**: sort either way, hide the column, control break, and the column's values with counts
  (with the report's search and filters) to filter by, with a search box. New route
  `GET /a/:alias/:page/report/:id/values?col=` (a visible interactive report, a column the user may see).
- **Search in one column**: a column list at the start of the search field (`r<id>_qc`).
- **Hidden columns** per user (`r<id>_x`): from the heading menu or Actions → Columns, shown as chips.
- **Pagination**: *1–14 of 14* also on one page, first and last page, rows per page in the pager.
- **Date items in the application's date format** (or their own date mask): a text field with a calendar button
  (the browser's picker), read back on submit; a wrong date is refused.
- **Display positions**: a region's *Position* (`meta.region.position`): banner, breadcrumb bar, left or right
  column, body (the default) or footer.
- **Left side column** and **Right side column** page templates: the left (or right) regions in a column beside
  the body; on other pages those regions show in the body.
- **Button positions**: a region button's *Button position* (`meta.button.slot`): create, edit, change, copy, help
  and up in the region's header, previous, close and delete at the left of its bottom bar, next at the right.
- **The Page Designer's layout** draws the page template's positions as drop zones and a region's button positions;
  dropping a region or button there sets its position (also from the gallery), with undo.
- **The rendering tree** groups regions by position and buttons by button position, colours type icons, and has a
  context menu: create in or below, **Duplicate**, **Copy to other page**, expand or collapse all below, delete.
- **The property editor**: *Common* / *All*, *Go to group*, Template options in a dialog; a page number field in
  the toolbar.

### Changed
- The default-password warning shows on the App Builder home and Developers only and can be dismissed until the
  next sign-in; the avatar has a red dot until the password is changed.
- The SQL Workshop's tools are five main tabs and a More menu: the strip no longer scrolls sideways.
- **The Actions menu** is a short menu (Columns, Filter, Data, Format, Chart, Group by, Pivot, Report, Download);
  each entry opens a dialog with its form (without JavaScript it unfolds in place).

## [0.42.0] - 2026-10-14

Sprint 71: generated applications read like APEX's (from a comparison of a pgkiln application made from existing
tables with one made by APEX 26.2 on the same HR data).
Sprint 72: the application's chrome like APEX 26.2's: the developer toolbar, the Iris look, the header's Help menu and
Install button.
Sprint 73: the Create Application wizard on one page, like APEX's.

### Added
- **Human labels in generated applications** (migration 097): `meta.wizard_label` splits `snake_case` and
  `camelCase`, recognises run-together words (`hiredate` → *Hire Date*) and expands common abbreviations (`emp`,
  `dept`, `sal`, `comm`, `mgr`, `no`, `qty`, `desc`, `pct`, `crm`, `id` …). New `meta.wizard_table_label` and
  `meta.wizard_column_label` prefer a short `COMMENT ON TABLE`/`COLUMN` (a longer column comment becomes the item's
  help), drop a foreign key's `_id`/`no` suffix and a leading table letter (`ename` → *Name*). Report pages and menu
  entries are plural (*Employees*), forms and dialog titles singular (*Employee*); report headings are Title Case.
- **Foreign keys by name in generated reports**: `meta.wizard_report` joins each foreign key to its parent's display
  column (the key stays hidden for filters); the wizards' report and form pages (`meta.generate_page` *report_form*,
  new `meta.wizard_report_form`) use it, with headings and number format masks.
- **File columns**: a `bytea` column is one file upload item bound to the columns that go with it (`<col>_name`,
  `<col>_mime`, `<col>_size`, `<col>_updated`, or `filename`/`mime_type`); reports leave them out
  (`meta.wizard_files`). File items take `size_column` (also for files in the database) and `updated_column`.
- **Number format masks** for generated number columns and items (`999G999G999G990D00`): the same notation in the
  report and the form.
- **A pencil per report row**: `{"link": {"icon": true}}` gives a report an edit column of its own; the key is then
  plain text.
- **A Home page** for new applications: a hero with the application's icon and name (no builder wording), and a card
  per page of the menu (list `HOME_PAGES`).
- **Charts**: horizontal bars get a value axis with gridlines; `"top": N` shows the N-1 largest rows and an *Other*
  row; generated charts label rows without a value *(none)* and are titled *Employees by Manager*.
- **Developer toolbar as a bar of icons** (APEX: the Runtime Developer Toolbar): App Builder, Application, Edit page,
  Session, Debug, Quick edit, **Customize** (the Theme Roller) and **Info** as icons with tooltips, centred at the
  bottom. It shrinks to a slim tab after a few seconds without use and comes back when pointed at or focused;
  **Settings** docks it at the bottom, top, left or right and turns the hiding off (kept in the browser). The page
  keeps room for it: it no longer covers the menu's last entry or a report's pager.
- **Lavender** base style: pgkiln's Iris until 0.41, for applications that want to keep it.
- **About page and Help menu** in generated applications (page 9000, list `NAVBAR` with Help → About).
- **Install app** button in the header of an installable application, where the browser offers the installation.
- The user menu shows the account's **display name** (the user name under it).
- Menu colour tokens (`--nav-text`, `--nav-muted`, `--nav-hover`, `--nav-current`) for styles with a dark menu.
- **Create Application on one page** (APEX: the Create Application wizard): name, description and icon; appearance
  (theme style, side or top menu, accent colour); a **page type per table and view** of the chosen schema (interactive
  report with form, faceted search, cards, calendar, master detail, interactive grid, report, or none; only the types
  a table can have are offered; tables of more than 100,000 rows are proposed as an interactive grid); **features**
  (About page, access control, activity reporting, feedback, theme style selection, install as an app, push
  notifications); settings with the primary language; a boilerplate under Advanced. The other sources (a file,
  pasted data, a blueprint, the App Gallery) are links at the top.
- **Activity reporting** (migration 098): `meta.app_activity(days)` gives an application's administrators its page
  views, sign-ins and errors; the feature adds an Activity page for them (page 9010).

### Changed
- The Dashboard of a generated application comes right after Home in the menu. Tables with row-level security are
  left out of it (their charts would be empty for the application's role), and the result page says so.
- The menu marks the Home entry only on the home page (it was highlighted on every page below it); a long menu
  scrolls to the current page's entry.
- Report headings are no longer upper case (`text-transform`); the heading text is shown as it is.
- `meta.generate_page` and the page wizards: `form_label` option; page labels from `meta.wizard_table_label`.
  `meta.generate_crud` is unchanged.
- **Iris looks like APEX 26's Iris**: a white body, a dark warm-grey header with a thin accent strip and a dark menu,
  a blue accent, 4 px corners, a rule under region headers, a dark primary button and a large bold page title on
  the body instead of a title band. Applications on Iris change with it; choose Lavender for the earlier look.
- New applications start in the light theme (users may still choose dark).
- The icon `info` works on its own (it was taken as the *info* colour modifier).
- After **Create application** the builder opens the new application (a progress message while it works), with
  what was created as a message, instead of a result page. "From existing tables" is part of the Create page
  (`/builder/create/tables` shows the same page).
- The proposed application name is selected when clicked, so typing replaces it.

## [0.41.0] - 2026-10-14

Sprint 67: REST source catalogs and a workspace's export and import. Sprint 68: the Data Reporter's welcome
page and Find my workspace. Sprint 69: dragging tasks on a Gantt chart. Sprint 70: treemap, sunburst and timeline
charts.

### Added
- **REST source catalogs** (migration 095; APEX: Workspace Utilities → REST Source Catalogs): a workspace's web
  services described once, with a base URL and services. Import an **OpenAPI 3 or Swagger 2.0** document (JSON: a
  file, pasted, or read from a URL on the allow-list) or a catalog file, or enter one by hand: services get their
  parameters, row selector, typed columns and write-back operations from the document, and what can't be used is
  listed. Shared Components → REST data sources → ＋ Add → **From a REST source catalog** makes a data source (a copy)
  from a service, with the application's own web credential.
- REST data source parameters take a **`key`**: the service's own name for a query, header or body parameter
  (`pageSize`, `X-Request-ID`) when it isn't lower case with `_`.
- **Workspace export and import** (APEX: Workspace Utilities → Export): Workspace utilities → *Export and import*
  writes the current workspace's settings, developers, application groups, extension links, REST source catalogs, SQL
  scripts, blueprints and data generators to one file (`pgkiln-workspace/1`) and imports such a file into the current
  workspace in one transaction, keeping or replacing components with the same name. For administrators and the
  workspace's administrators.
- **The Data Reporter's welcome page** (APEX 26.1): a greeting, the data sources as cards that start a report (label,
  description, number of columns), the user's own reports with the latest changed first, shared reports, and a search
  over names and descriptions. `welcome_title` / `welcome_text` replace the greeting; `"welcome": false` keeps the
  compact start. New texts in all 22 languages.
- **Find my workspace** (migration 096; APEX: the sign-in page's Find My Workspace): developers' e-mail addresses
  (their own on the Developers page; administrators set anyone's), Workspace utilities → Mail services → **Builder
  mail**, and a page under the builder's sign-in form that mails an address's accounts their workspaces. The same
  answer for every address, the mail after the answer, at most three mails an hour per address and ten requests an
  hour per IP address.
- **Gantt editing by drag and drop** (APEX: Gantt task dragging): a Gantt chart with `gantt_move` (SQL with
  `:TASK_ID`, `:NEW_START`, `:NEW_END`) and a `task_id` column lets users who pass `gantt_move_authz` drag a task to
  new dates, drag a bar's end to change its length, or do both with the arrow keys (Shift: the end; Enter saves). The
  server checks the dates and that the task is in the chart's query, runs the SQL as the application's role and
  sends the chart back. Builder: Chart settings → *Gantt: drag and drop*. HR example part 59 makes the office move on
  page 32 editable for managers.
- **Treemap, sunburst and timeline charts** (APEX: Oracle JET treemap, sunburst and timeline): a treemap and a
  sunburst read `label, value` and optional `node_id` / `parent_id` columns for a hierarchy (squarified rectangles;
  rings with the total in the centre); a timeline reads `label, start, end` with an optional `series` column for
  lanes (points and periods, overlaps in rows). Tooltips, drill-down links and data tables like the other charts.
  HR example part 60 adds one of each to page 32.

### Security
- Reserved headers (`Authorization`, `Cookie`, `Host`, the transport headers) can't be REST data source header
  parameters, also not under a `key`.

### Fixed
- **Offline pages keep their script and styles after an update:** a page kept on the device under an older version of
  pgkiln's static files got neither `app.js` nor `app.css` offline once the service worker had cached the newer ones;
  it now gets the cached copy of the other version. (This was also the cause of the intermittent CI failure of the
  e2e test "a form sent offline …".)

## [0.40.0] - 2026-10-14

Sprint 65: facet charts. Sprint 66: a blueprint from an existing application.

### Added
- **Facet charts** (APEX: facet charts): a faceted search facet with `"chart": "bar"` or `"pie"` (builder: the *Chart*
  column of the facets table) shows its counts as a chart, collapsed under its heading; a bar or slice links to the
  page filtered on its value. HR example part 58 adds them to page 21.
- **A blueprint from an existing application** (APEX 26.1): Blueprints → *From an application* opens a blueprint of an
  application of the workspace in the editor: the tables its pages read (columns, types, required, unique, allowed
  values, references), its pages and its menu, and up to 20 sample rows per table when asked for, with notes on what
  didn't carry over. Review and create it like any blueprint, e.g. for a copy or a test system.

## [0.39.0] - 2026-10-13

Sprint 62: workspace preferences, Manage backups and the SQL Workshop utilities. Sprint 63: range, box plot and stock
charts. Sprint 64: vacation rules and expiration policies for approvals.

### Added
- **Workspace preferences** (migration 093; APEX: Set Workspace Preferences): administrators and a workspace's
  administrators turn the **SQL Workshop** off for the workspace (every SQL Workshop page answers 403 while it is
  current, and it leaves the rail) and its applications' **RESTful services** (their REST modules answer 404).
- **Extension links** (APEX: Manage Extension Links): a workspace's links to other tools, in an **Extensions** menu of
  the builder's rail.
- **Manage backups** in Workspace utilities: the backups of every application of the workspace on one page, and
  *Back up now* for all of them (only the changed ones by default).
- **SQL Workshop → Utilities** (APEX: SQL Workshop Utilities): the workshop's tools on one page, **Object Reports**
  (tables without a primary key, foreign keys without an index with the index to add, row-level security without
  policies or not enabled, PUBLIC grants, unused indexes, largest tables, tables without a comment), **About
  Database** (version, settings, extensions, schema sizes) and a read-only **Database Monitor** of sessions and
  blocked queries for administrators.
- **Range, box plot and stock charts** (APEX: Oracle JET range, box plot and stock charts): floating columns from low
  to high (several pairs per row); boxes with whiskers from one value column with a row per observation (computed
  per label, like `percentile_cont`) or from five statistics per row; candlesticks from open, high, low and close. Texts
  in the 22 built-in languages; HR example part 56 adds them to page 32.
- **Vacation rules for approvals** (migration 094; APEX: vacation rules): on a task list of *my tasks* users name a
  stand-in from one day until another; while the rule is active, the stand-in acts on the tasks they own by name or
  are assigned, checked on every request. `meta.set_vacation_rule`, `meta.clear_vacation_rule`, `meta.vacation_rule`.
- **Expiration policies for task definitions** (APEX: expiration policy): an overdue task expires, has its due date
  renewed (up to a maximum), or escalates once to a role with priority 1; the scheduler applies them every minute
  (`meta.task_expire_tick`). A workflow waiting for an expired task goes on with the outcome `expired`. HR example
  part 57 sets them for leave and access requests.

### Fixed
- A chart axis with many labels showed them cut off (e.g. "0." for "02 Sep"): the labels shown use the room of the
  hidden ones, and a narrow chart shows every other one.
- Progressive Web Apps: the service worker could be stopped before it kept a visited page, so a form sent offline right
  after opening its page showed the offline page instead of "Saved on this device" (the cause of an intermittent e2e
  failure).

### Changed
- APEX parity: the Manage Service and SQL Workshop rows lose their Missing notes on workspace preferences, extension
  links and the SQL Workshop utilities.

## [0.38.0] - 2026-10-13

Sprint 61: the builder's screens like APEX 26.1's.

### Added
- **A sign-in page like APEX's**: a pgkiln panel beside the form, an optional **workspace** (it becomes the current
  one; a wrong one answers like a wrong password), a *Show* button for the password, **Remember workspace and
  username** (an HttpOnly cookie for `/builder`, never the password) and an *Administration* link that opens
  Workspace utilities after signing in.
- **The Administration menu** in the icon rail (it replaces the Users and Developers icons): Workspace utilities;
  *Manage service* for the current workspace's administrators (workspace message and environment banner, workspace
  utilization, the workspace's page); Manage users and groups, Developers, Monitor activity, Change my password.
- **A workspace message** (on the App Builder home) and an **environment banner** (a coloured label such as
  DEVELOPMENT across the top of every builder page of the workspace), set by administrators and workspace
  administrators (migration 091).
- **Workspace utilization**: applications, pages, developers, page views and users of the last 30 days, static
  files and the storage of the schemas the workspace's roles use.
- **The SQL Workshop home**: tiles, recently created tables, your recent SQL commands (click to open one) and the
  workspace's recent scripts, and the session's **schema**, first in the search path of SQL Commands and SQL
  Scripts. SQL Commands moved to `/builder/sql/commands` (a post to `/builder/sql` still runs).
- **The App Gallery**: *Sample Apps* (HR Demo, Tasks) installed by administrators; *Starter Apps* (Team Tasks,
  Contacts, Expense Claims, Asset Inventory, Event Registrations) shipped as blueprints and created after their review;
  *Custom Apps*: the workspace's boilerplates.
- **Application groups** (migration 092): a workspace's named groups of applications, a group filter and labels on
  the App Builder home.
- **Cross Application Reports** in Workspace utilities: application attributes, build options, developer comments,
  authentication, authorization schemes, password items and theme summary over the workspace's applications.

### Fixed
- A calendar region whose query has no `end_date` column (e.g. one made by the calendar wizard without an end
  column) failed with "column __q.end_date does not exist".

### Changed
- APEX parity: 144 features compared (four builder screens added), 141 available, none partial or missing, 3 not
  planned.

## [0.37.0] - 2026-10-13

Sprint 60: isolated workspaces.

### Added
- **Isolated workspaces** (APEX: a workspace as a tenant boundary): an administrator isolates a workspace on its page
  (Workspace utilities → Workspaces). Its applications then run on a PostgreSQL login of their own and its developers'
  SQL (SQL Commands, SQL Scripts, Quick SQL, Load and Unload Data, Sample Data, DDL and Compare, the Advisor, code
  checks, document previews) on another; SQL that runs `RESET ROLE` only gets back to that login. Row-level security
  on pgkiln's own tables shows each login its own workspace's applications, pages, sessions and accounts, and hides
  isolated workspaces from the shared runtime connection. The logins' passwords are derived from `PGKILN_SECRET_KEY`;
  `RUNTIME_DATABASE_URL` must be set (migration 090).
- **A workspace's database roles** (APEX: workspace schemas): an isolated workspace's applications run only as the roles
  an administrator gave it (isolating gives it the roles its applications use); a new application there gets a new
  role and schema of its own. An import or a settings change can't claim another workspace's (or any other) role.
- SQL scripts and their runs, blueprints and sample data generators belong to the workspace they were made in.
- **Workspace administrators** (APEX: workspace administrators): an administrator marks developers of a workspace as
  its administrators; they open its page from Workspace utilities and manage its name and developers.

### Changed
- `meta.app_id()` refuses an application of another isolated workspace, so `meta.web_request`, `meta.ai_generate`,
  `meta.send_mail`, `meta.send_push` and `meta.page_url` can no longer act for another workspace's application
  (the known gap in SECURITY.md, for isolated workspaces).
- A workflow step's SQL in an isolated workspace runs on the workspace's login and commits just before the
  workflow's own state (a step may run again after a crash between the two).
- Data load definitions can only be saved for applications of the current workspace.
- Sample data generators' and SQL scripts' names are unique per workspace (`on conflict (workspace_id, name)`).
- APEX parity: 140 features compared, 137 available, none partial or missing, 3 not planned.

## [0.36.0] - 2026-10-12

Sprints 54 to 59: interactive grid views; the login page and "Forgot password?"; Generate DDL and Schema Comparison; region templates; page groups; Quick edit and the help pane.

### Added
- **Interactive grid views** (APEX: Single Row View, Group By, Chart): the **single row view** shows one row of the
  search as a form, with First/Previous/Next/Last and *Add row*, opened from Actions or a row's menu and saved by the
  grid's `grid_dml` process with the same checks; **group by** and **chart** are set up in the Actions menu, as for an
  interactive report. The region attribute `views` (builder: *Views*) limits them.
- **An editable login page** (APEX: the login page): *Application settings → Sign-in methods → Create a login page*
  adds page 9999 with the new **Login** region (the sign-in form) and makes it the application's login page;
  `/a/<alias>/login` sends visitors there and failed sign-ins come back to it with their message. Add any regions
  around the form in the Page Designer (migration 087).
- **Page template *Minimal (no navigation)***: a page without the header and navigation menu.
- **Forgot password?** for user directory passwords, when the application has an enabled mail service: a single-use
  link valid for 30 minutes, mailed in the user's language; the answer is the same whether or not an account
  exists; limited per address and account; setting the new password ends the account's sessions.
- The Advisor reports a login page that is missing, requires authentication or has no Login region.
- **Generate DDL** and **Schema Comparison** (APEX: SQL Workshop → Utilities): SQL Workshop → *DDL* writes a schema's
  objects from the catalog in an order that runs (types, sequences, tables, functions, views, constraints, indexes,
  triggers, row level security, comments, grants), unqualified so the script also creates them in another schema;
  *Compare* lists the differences between two schemas with a diff and writes a change script that makes the target
  like the source (drops commented out for review). Also `pgkiln ddl`, `pgkiln compare` and the MCP tools
  `generate_ddl` and `compare_schemas`.
- **Region templates** (APEX: Hero, Title Bar, Buttons Container, Inline Dialog, Inline Drawer, Wizard Container,
  Carousel): templates `hero`, `title_bar`, `buttons_container`, `inline_dialog`, `inline_drawer` (opened by the dynamic
  action *Open region* or a link to `#R<id>`) and `wizard` (migration 088); the list template `wizard_progress`; the
  display selector style `carousel` (Previous, Next, dots, optional `interval`). HR example page 44.
- **Page groups** (APEX: Page Groups): Shared Components → Page groups, a page's *Page group*, the App Builder's page list
  with a group column and filter; renaming or deleting a group follows on its pages; exported with the application
  (migration 089). The HR pages are in four groups.
- **Quick edit** (APEX: Quick Edit) on the developer toolbar: point at a region, item or button of a running page and
  click it to open it in the Page Designer.
- The Page Designer's **Help pane**: the focused property's help, the name it is stored under and the guide section
  of the component's type.

### Fixed
- Pages could keep an old `app.css`, `app.js` or icon sprite from a PWA's service worker cache after pgkiln's
  static files changed (unstyled navigation bar items and developer toolbar): the files are now asked for with a
  version from their contents (`?v=…`), looked up again when they change, and the service worker matches the exact URL.
- A refused sign-in (throttled, an expired form, a sign-in method that is off) could answer with an empty page:
  the handler no longer returns before the sign-in page is sent.

### Changed
- The code editor's line numbers have enough contrast (WCAG AA) in light and dark mode.
- After **Save**, a grid comes back with its search, page, sort and view instead of the page's defaults.
- APEX parity: 140 features compared, 136 available, 1 partial (workspace isolation), none missing, 3 not planned.
  The row for built-in runtime messages in ~34 languages is removed: more built-in languages are not planned (the 22
  stay; an application's own text messages cover others).

## [0.35.0] - 2026-10-12

Sprint 53: data and settings.

### Added
- **Application settings** (APEX: `APEX_APP_SETTING`): Shared Components → Application settings, with valid values
  and *required*; `meta.get_app_setting` and `meta.set_app_setting` from application code. Exported with the
  application; an import over it keeps the installed values (migration 086).
- **User preferences** (APEX: `APEX_UTIL.GET/SET/REMOVE_PREFERENCE`): `meta.get_preference`, `meta.set_preference`,
  `meta.remove_preference`; items with `{"persist": "user"}` keep their value per user across sessions.
- **Dynamic translations** (APEX: `APEX_LANG.LANG`): Shared Components → Dynamic translations and `meta.lang(text)`
  for values from tables, e.g. in a list of values.
- **Data export** (APEX: `APEX_DATA_EXPORT`): `meta.data_export(query, format, options)` returns a query's rows as
  CSV, JSON, XML or HTML with the caller's privileges; the download process's `{"export": …}` sends them as CSV,
  JSON, XML, HTML, Excel or PDF.
- **Display image** items: a picture from an https URL, a path, or a BLOB from a query.
- **Geocoded address** items: *Check address* asks the installation's geocoder (`GEOCODER_URL`, Nominatim-compatible)
  and puts the chosen address's position into another item.
- HR example page 43 *Data and settings*.

### Changed
- APEX parity: 140 features compared, 130 available, 5 partial, 2 not yet, 3 not planned.

## [0.34.0] - 2026-10-12

Sprint 52: page behaviour.

### Added
- **Dynamic actions**: the events Get/Lose Focus, Key Release, After Refresh, Selection Change, Before Page Submit and
  custom events (`pgkiln.trigger`); the actions Confirm, Close Dialog, Cancel Dialog, Clear, Open/Close Region,
  Download, Print, Get Current Position and Share. The actions of one event now run one after the other in sequence
  order, and a declined Confirm stops the ones after it (migration 085).
- **Ajax callbacks** (APEX: On Demand processes): page and application processes with point *ajax*, called from
  JavaScript with `pgkiln.server.process(name, {items, x01 … x10})`, answer JSON.
- **Error handling function** (APEX): an application's `schema.function(jsonb) returns jsonb` rewrites the error
  messages users see.
- **Session timeout warning**: a dialog before the session ends, with *Stay signed in*.

### Changed
- APEX parity: 140 features compared, 126 available, 5 partial, 6 not yet, 3 not planned.

## [0.33.2] - 2026-10-12

### Added
- **Mail services: check before saving.** *Test connection* checks the settings as filled in without sending
  (SMTP sign-in, an Entra token, the SES account, or a read-only call with the API key), and *Send test mail*
  sends one message; both while adding a service too, the answer shown in place.

## [0.33.1] - 2026-10-12

### Changed
- **Mail services**: *Add service* first asks for the provider (tiles with a description each), then shows only that
  provider's settings in groups, with OAuth2 and the API base URL folded away; a service's page switches provider with
  *Provider → Change*. The services list is full width.

## [0.33.0] - 2026-10-12

Sprint 51: safe deployments and feedback.

### Added
- **Checked imports**: `pgkiln import --check` runs the Advisor on the imported application inside the import's
  transaction (every SQL fragment planned as the application's role, references checked) and refuses on errors,
  so nothing changes; `--dry-run` only checks, `--force` imports anyway. The MCP server's `import_app` checks by
  default (`force`, `dry_run`), and the builder's Import has the check ticked.
- **Application backups** (APEX: Application Backups): before every import that replaces an application (CLI,
  MCP, working copy merge, restore), daily when it changed, and by hand; download, restore, keep the newest N
  (Application → Backups; migration 082).
- **Application availability and build status** (APEX: Availability, Build Status): available, developers only,
  restricted to named users or unavailable with a message, for pages, downloads, REST modules and PostgREST;
  *Run only* refuses builder changes as if the application were locked. Not exported, kept by an import
  (migration 083).
- **Feedback** (APEX: Feedback): users send a comment, idea or problem from the navigation bar and see the
  developers' answers; developers answer under Application → Feedback (migration 084).
- A region's *Attributes (JSON)* help in the Page Designer shows its own type's keys with a link to the guide.

### Changed
- APEX parity: 140 features compared, 121 available, 6 partial, 10 not yet, 3 not planned.

## [0.32.0] - 2026-10-12

Sprint 50: six APEX parity items, e-mail among them.

### Added
- **E-mail** (APEX: `APEX_MAIL`, the Send E-Mail process, Email Templates): `meta.send_mail`,
  `meta.send_mail_template`, `meta.add_mail_attachment` and `meta.mail_status` queue mail in the caller's
  transaction; the server sends it after the commit, with retries, and keeps a 30-day log (Applications → Activity →
  Mail, with retry and cancel). **Mail services** (Workspace utilities, administrators) go further than APEX's SMTP:
  SMTP with a password or **OAuth2** (XOAUTH2, e.g. Exchange Online), **Microsoft 365 through Graph**, **Amazon
  SES**, **Resend**, **Postmark**, **SendGrid**, **Mailgun**, or log only; secrets encrypted and write-only; allowed
  senders; a service, From address and daily limit per application. A `send_email` process and Shared Components →
  **E-mail templates** (exported). Only the current application, called as its own database role, can send.
  Migration 081; new dependency `nodemailer`. The HR example mails a decided leave request (through a log-only
  service). This reverses the earlier "no e-mail" decision (migration 008).
- **Search configurations and the search region** (APEX 22.2): one search field over tables, queries and lists, the
  results grouped, the words marked, searching as you type (migration 080; HR page 42).
- **URL region**: another site's page in a sandboxed frame; the origin is literal and the page's CSP gets
  `frame-src` for exactly that origin (migration 078).
- **Developer toolbar** (APEX: Runtime Developer Toolbar) on the pages of a developer's applications: App Builder,
  Edit page, the **session state viewer** and debug messages for one session (migration 079).
- **Warn on unsaved changes** (APEX: the page attribute of the same name): the browser asks before leaving a page
  with changed items; `pgkiln.isChanged()` (migration 077).
- **Lost update detection** for forms (APEX: Prevent Lost Updates, Lock Row): a checksum of the row as shown,
  checked with the row locked on Save and Delete; `meta.row_version()` (migration 076).

### Changed
- **APEX parity matrix** reviewed: what an import checks (the export, not the application's tables, columns and
  functions) and that an import with `--replace` is live at its commit; new rows for property help in the Page
  Designer (partial), application availability (not yet) and e-mail. 140 features compared: 119 available,
  5 partial, 13 not yet, 3 not planned.
- The interactive grid's "unsaved changes" question is translated.
- Dependencies: `xml-crypto` 6.3.3 (SAML signature checks), `@fastify/multipart` 10.1.3, `@fastify/static` 10.1.6,
  `@fastify/cookie` 11.1.3, `pg` 8.23.1 and other patch releases; new: `nodemailer` 10 (SMTP).

## [0.31.0] - 2026-10-09

The first public release, on GitHub, Docker Hub (`pgkiln/pgkiln`) and npm (`pgkiln`).

### Added
- **Website** at [pgkiln.vargar.eu](https://pgkiln.vargar.eu): a landing page and the user guide with search, built
  with VitePress from `website/` (the guide is synced from `docs/` at build time), published with
  `website/scripts/deploy.sh`.
- **MCP server for AI coding agents** (`pgkiln mcp`, docs/guide/20-ai-agents.md): Claude Code, Cursor and other
  agents can list applications, read an application's settings, pages and shared components as YAML, describe
  tables with their RLS policies, run read-only queries, search the user guide and read recent errors; and change an
  application by exporting it to `apps/<alias>`, editing the files, `diff_app`, and `import_app` with `replace`
  (one transaction, as `pgkiln import --replace`). `.mcp.json` starts it for Claude Code in a checkout; `CLAUDE.md`
  tells agents how to work on applications and on pgkiln. `run_query` runs one statement in a read-only
  transaction and hides password, secret and token columns.
- **Screenshots** in the README (`docs/images/`, made by `npm run screenshots` from the HR example).
- **Docker**: a `Dockerfile` and `deploy/compose.yaml` (PostgreSQL 17 + pgkiln, optional Caddy for HTTPS):
  `cp .env.example .env`, fill in four secrets, `docker compose up -d`. The container (`scripts/docker-start.ts`)
  refuses empty or too short secrets (listing all problems at once), migrates under an advisory lock, sets the
  runtime role's password from `.env` unless it already works, replaces the builder's `admin` / `admin` and gives
  `pgkiln_authenticator` a random password while it has its default (roles it creates get their passwords at once;
  what it can't check, e.g. under `trust`, it logs); a wrong database password stops it at once, an unreachable
  host after the 2-minute wait; works with Docker Engine before 25; optional HR example (`PGKILN_EXAMPLE=hr`). Port bound to 127.0.0.1 by default;
  your own PostgreSQL by leaving out the `db` profile. `GET /healthz` for health checks; a CI job starts the
  stack as a user would. `tsx` moved to the runtime dependencies (the server and the CLI run with it).
- Installation guide: installing into an existing database (the grants an administrator gives).
- **Static application files** (migration 068): Shared Components → Static application files uploads or writes
  JavaScript, CSS, JSON, images and fonts (no HTML), served at `/a/<alias>/static/<name>` with long caching per
  version; every page or one page loads chosen `.js` and `.css` files; exported with the application (as the files
  themselves under `static/` in a directory export).
- **Execute JavaScript** dynamic action: calls a function a static file registered with
  `pgkiln.actions.register(name, fn)`; the page receives only the name, so the CSP stays `script-src 'self'`.
  `window.pgkiln` also offers `getValue`, `setValue`, `showSuccess`, `showError` and `clearErrors`. HR example:
  the salary per year on the employee form (`hr_46`).
- **Plug-ins with their own code** (migration 069): region, item, dynamic action and process plug-ins in one
  `pgkiln-plugin/2` file (attributes, JavaScript/CSS as static files registered with `pgkiln.plugins.register`, a
  template component for regions, a PL/pgSQL function for processes, install SQL run only on request as the app's
  role). Shared Components → Plug-ins; `meta.import_plugin()`; `pgkiln plugin build|install`; four examples in
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
  (`"tiles": true`, MVT 2.1 encoded by pgkiln without a dependency, at most 10,000 rows per tile), drawn on canvases
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
- **Application files as text** (APEX 26.1: APEXlang): `pgkiln export --format text` (and the builder's
  `?format=text` zip) writes the directory export as YAML, a strict subset any YAML tool reads, with SQL and templates
  inline as literal blocks; `import`, `diff` and zips read JSON and YAML files alike.
- **Region Static ID** (migration 073): optional, unique on the page; names the region in exported files (so renaming
  it keeps its file, references and, on `import --replace`, saved reports) and is rendered as `data-static-id`.
- **Lucide icons and icon modifiers** (APEX: Font APEX): about 1,600 more line icons (the `lucide-static` package,
  ISC) next to pgkiln's 136, each served as its own cached file; modifiers after the name (`lg`, `2x`, `spin`,
  `rotate-90`, `flip-h`, `success`, …) and Font APEX names (`fa-users fa-lg`); the builder's icon picker searches
  them and takes any value.
- **Push notifications for Progressive Web Apps** (migration 074; APEX: APEX_PWA push notifications): Settings →
  Progressive Web App → *Push notifications*; users turn them on per device (My account → Notifications, or the
  new dynamic action `push_subscribe`); `meta.send_push(user, title, body, page, items, tag, urgency, ttl)`,
  `meta.has_push_subscription(user)` and the new process type `send_push` queue them, and the server sends them
  after the commit (NOTIFY, else the scheduler), encrypted per device (RFC 8291) and signed with the application's
  own VAPID key (RFC 8292; `meta.push_key`, encrypted with `PGKILN_SECRET_KEY`, never exported). Links are pages of
  the app signed for the recipient. Endpoints only at the browsers' push services (`PGKILN_PUSH_HOSTS`); devices
  end at sign-out, a new password, deactivation or removed access, and on 404/410. Builder: devices, results, a
  test notification, new keys. No new dependency. HR example (`hr_49`): a leave request notifies the manager's
  devices, a decision the employee's; the notification opens the request.
- **Parity review**: `docs/apex-feature-parity.md` compares 18 more APEX features (Ajax callbacks, dynamic action
  events and actions, lost update detection, region templates, the developer toolbar, …); the form, PWA and
  unsaved-changes rows were 🟡 or ❌ in fact and now say so.

### Security
Fixes from the security review of 2026-10-08 (details and severities in SECURITY.md; migration 075).
- **Hidden report columns** can no longer be shown, searched, filtered, sorted or aggregated by editing
  the URL (computed columns, filters, highlights, control breaks, group by, pivot and chart views).
- **REST modules**: `:APP_USER`, `:APP_ID` and the other built-in binds come from the server; a caller's
  `?app_user=…` (or body field) no longer sets them. AI assistant tool arguments can't either.
- **Single sign-on** links an existing account with the same username only when the provider allows it
  (*Link existing accounts*, new column `auth_provider.link_existing`; **on for providers that exist at the
  upgrade** so sign-in keeps working: review it), and with the e-mail claim only when the address is
  verified. SAML usernames are checked like OpenID Connect ones.
- **Lists of values are enforced**: select lists, radio groups, checkbox groups, shuttles and grid select
  columns only accept values their list returns (`"any_value": true` opts out).
- **URL checksums** are unambiguous (byte lengths and a version in the signed text): links signed before
  the upgrade (bookmarks, notifications) ask for a new checksum.
- **My account**: wrong current passwords count towards the sign-in throttle; database, custom and header
  apps no longer offer the password form.
- **Identity providers, LDAP directories and the password policy** are for administrators only; granting
  access is limited to applications of the developer's workspaces.
- A **DELETE** runs the validations made for it (`when_button` `DELETE`); before, it ran none.
- **`TRUST_PROXY=true`** trusts one proxy, not every `X-Forwarded-For` entry; a number or addresses for more.
- **`?doc=`** on a page that doesn't require sign-in only gives the templates the page offers with a button.
- The **bind scanner** follows PostgreSQL's lexer for non-ASCII dollar-quote tags, `$` in identifiers,
  `\r` ending a comment and `WHERE'…'`.
- SECURITY.md: the application role is not a sandbox for developer SQL (`RESET ROLE`), and the
  administrator pages are not a boundary while the SQL Workshop runs as the owner.

### Fixed
- **The server could freeze under load.** A page request holds a database connection for its transaction, and the
  navigation lists and map regions asked the same pool for a second one. With as many simultaneous requests as pool
  connections (10 by default, so about 20 users signing in at once), every connection waited for another and the
  server stopped answering until it was restarted. Such queries now use a small pool of their own
  (`DB_NESTED_POOL_SIZE`); waiting for a connection fails after `DB_ACQUIRE_TIMEOUT_MS` instead of forever, and the
  database ends transactions left idle (`DB_IDLE_IN_TRANSACTION_MS`). Regression test: `test/pool.test.ts`.
- Query Builder: after *Apply* the tables kept the order of the list instead of the order chosen, so the aliases
  (and the ticked columns and conditions) could point at the other table.
- The e2e test of the crop dialog failed on CI: it waited with an async predicate, which Playwright treats as true
  at once.

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
- **Nine more built-in languages** for pgkiln's own texts: Italian, Portuguese, Polish, Swedish, Danish, Norwegian,
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
- **Installation log**: every migration run is logged in `public.pgkiln_install_log`; Workspace
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
  imported synchronisation starts switched off. `pgkiln import --replace` keeps the new secrets.

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
  in; superusers and pgkiln's own roles never.

### Changed
- Report PDFs read their rows from a cursor in batches of 500 and draw them as they arrive
  (`PDF_MAX_ROWS`, default 5,000, at most 100,000).
- REST collection handlers stream a chunked JSON array from a cursor.

## [0.21.0] - 2026-10-04

### Added
- **HTTP header authentication** (APEX: HTTP Header Variable; migration 036): an app type `header` for
  apps behind a reverse proxy or SSO gateway that sets the user in a header (`X-Remote-User` by
  default). The header is trusted only from the proxy addresses in `PGKILN_AUTH_HEADER_PROXIES`; the
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
- HR page 23's hint now names `PGKILN_REST_PRIVATE_HOSTS=127.0.0.1:3100`.

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
  an **Invoke API** page process. Outgoing calls only to hosts on `PGKILN_REST_ALLOWED_HOSTS`, with
  SSRF checks; secrets need `PGKILN_SECRET_KEY`.
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
  pgkiln version.

### Fixed
- **Map tiles from OpenStreetMap showed "Access blocked" (403)**: pgkiln's `Referrer-Policy:
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
- **The `pgkiln` command line**: `migrate`, `apps`, `export` (one JSON file or a directory),
  `import` (JSON, directory or .zip; `--replace` updates an application in place and keeps its
  access, sessions, saved reports, tasks and workflows), `diff` and `users`.
- **One file per component** (APEX 26.1: APEXlang-like app files): `pgkiln export --format dir`
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
  1.9 ships with pgkiln and loads only on pages with a map; tiles come from OpenStreetMap or the
  server in `MAP_TILE_URL`, the only image origin added to the Content-Security-Policy.
- **Tree region** (`tree`; APEX: Tree): id/parent id/label rows as an expandable tree with icons
  and links, drawn on the server (works without JavaScript).
- Builder settings forms for both; the Advisor checks their SQL. The HR example maps its offices
  and shows its reporting lines as a tree.

## [0.12.0] - 2026-10-01

### Added
- **REST modules** (Shared Components → REST modules, migration 024; APEX: RESTful Services):
  handlers with a method, a path with parameters and SQL (a paged collection, one item, or
  statements), roles and public endpoints, served by pgkiln under `/a/<alias>/rest/<module>/` with
  bearer tokens, as the application's role (RLS applies), and an OpenAPI description per module.
  The HR example has a `v1` module.

### Changed
- Tokens and OAuth clients no longer need an API role: without one they are valid for the REST
  modules pgkiln serves (PostgREST treats them as anonymous).
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
  run by the pgkiln server (on `NOTIFY` and every few seconds; `WORKFLOWS=off` to disable) one step
  per transaction as the application's role. A `workflows` region is the console (terminate, retry
  a faulted step); the builder checks the steps and draws them. The HR example starts an onboarding
  workflow from its employee form.

### Changed
- `Permissions-Policy` allows the camera and geolocation for the application itself
  (`camera=(self), geolocation=(self)`); the microphone stays off.

## [0.10.0] - 2026-10-01

### Changed
- **pgkiln installs no application.** The HR sample moved from `db/seed/` to `examples/hr/` as an
  example application built on pgkiln: `npm run setup` and `npm run db:reset` install the framework
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
  wrapped `export_app_base`/`import_app_base` chain). The format stays `pgkiln/2` and is now
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
  builder. The pgkiln server schedules them (no extension needed); several servers never run
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
  password pages. pgkiln doesn't send mail; administrators set temporary passwords (with change on
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
  - pgkiln's own texts in English and Dutch;
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
- REST APIs with PostgREST running next to pgkiln (`docker compose --profile api`): `meta.app_user()`, `meta.app_id()` and `meta.has_role()` understand PostgREST's JWT claims, so the same RLS policies protect the UI and the API; a per-application API role; the pre-request check `meta.api_check()` (inactive accounts and revoked access are refused at once); Builder → App → REST API with endpoints, token issuing and curl examples. The HR sample has an `api` schema (`db/seed/hr_03_api.sql`). New chapter 13.
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
